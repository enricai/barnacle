import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { FastifyInstance, FastifyReply } from "fastify";

import { cacheStats as defaultCacheStats } from "@/cache/response-cache";
import { config as defaultConfig } from "@/config";
import { prisma } from "@/lib/db/client";
import { toErrorMessage } from "@/lib/errors";
import { getLogger } from "@/lib/logging";
import { getTelemetryState, type RunState } from "@/lib/telemetry/run-state";
import { allMetrics, type SiteMetrics } from "@/scraper/metrics";
import { poolStats as defaultPoolStats } from "@/scraper/pool";

const logger = getLogger({ name: "routes/health" });

/**
 * One probed dependency's state. `ok: false` degrades the overall
 * readiness to 503 — orchestrators (k8s, ECS) should pull the pod from
 * rotation until the issue clears.
 */
interface DependencyStatus {
  ok: boolean;
  detail?: string;
}

/** Latest verdict from the recon-heal loop for one site. */
interface HealSummary {
  verdict: string;
  bestPassRate: number;
  reportPath: string;
}

interface ReadinessReport {
  status: "ready" | "degraded";
  checks: {
    database: DependencyStatus;
    scraperCredentials: DependencyStatus;
    scraperPool: DependencyStatus;
  };
  /**
   * Non-gating runtime stats exposed for ops dashboards. Never
   * influences the ready/degraded verdict — just gives operators a
   * single probe to see cache + pool pressure without adding routes.
   */
  stats: {
    scraperPool: { size: number; pending: number; concurrency: number };
    cache: { size: number; max: number; inFlight: number };
    /** Per-site drift-detection counters (spec §6B). Rising fallbackActivations signals recon should re-run. */
    metrics: Record<string, SiteMetrics>;
  };
  /** NDJSON event-stream telemetry for the current run. */
  telemetry: RunState;
  /**
   * Latest heal-loop verdict per siteId, populated by scanning heal-out/.
   * Empty object when no healing reports exist.
   */
  heal: Record<string, HealSummary>;
}

/**
 * Narrow subset of AppConfig the readiness probe needs. Kept inline
 * rather than imported as `Pick<AppConfig,…>` to keep this module
 * decoupled — health checks shouldn't be coupled to config surface
 * churn beyond these fields.
 */
export interface HealthConfig {
  databaseUrl: string | undefined;
  scraper: {
    steelApiKey: string | undefined;
    anthropicApiKey: string | undefined;
    readinessQueueThreshold: number;
    useBedrock: boolean;
  };
  bedrock: {
    accessKeyId: string | undefined;
    secretAccessKey: string | undefined;
    region: string;
  };
}

interface HealthRoutesOptions {
  config?: HealthConfig;
  /** Override for tests — defaults to the live pool stats. */
  poolStats?: () => { size: number; pending: number; concurrency: number };
  /** Override for tests — defaults to the live response-cache stats. */
  cacheStats?: () => { size: number; max: number; inFlight: number };
  /** Override for tests — defaults to the live telemetry run state. */
  telemetryState?: () => RunState;
  /**
   * Override for tests — root directory scanned for heal-out/<siteId>/healing-<siteId>.md.
   * Defaults to process.cwd().
   */
  healOutRoot?: string;
}

const DB_CHECK_TIMEOUT_MS = 1500;

/**
 * Pings the database with a trivial `SELECT 1` under a short timeout.
 * We avoid any Prisma model query — the readiness probe must not hold
 * connections or contend with real traffic.
 *
 * When DATABASE_URL is unset (e.g. local dev without a DB), the check
 * is treated as disabled rather than failed — the server still starts
 * and routes that don't touch Prisma keep working.
 */
async function checkDatabase(cfg: HealthConfig): Promise<DependencyStatus> {
  if (!cfg.databaseUrl) {
    return { ok: true, detail: "DATABASE_URL unset — skipped" };
  }
  // Clear the timeout when prisma resolves so setTimeout can't keep the
  // event loop alive past shutdown, and unref() the timer so a hanging
  // query can't block process.exit during ops drills. The original
  // Promise.race left the timeout live on the happy path and pinned
  // the event loop on the sad path.
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("timeout")), DB_CHECK_TIMEOUT_MS);
    timer.unref();
  });
  try {
    await Promise.race([prisma.$queryRawUnsafe("SELECT 1"), timeout]);
    return { ok: true };
  } catch (err) {
    return { ok: false, detail: toErrorMessage(err).slice(0, 200) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Confirms the scraper has the secrets it needs. When Bedrock is enabled,
 * validates key-pair consistency: if one of accessKeyId/secretAccessKey is
 * set the other must be too. If neither is set, ambient IAM credentials are
 * assumed (ECS task role, EC2 instance profile) — these can't be probed
 * synchronously at health-check time. When Anthropic is the provider,
 * verifies the API key is present.
 */
function checkScraperCredentials(cfg: HealthConfig): DependencyStatus {
  const missing: string[] = [];
  if (!cfg.scraper.steelApiKey) missing.push("STEEL_API_KEY");

  if (cfg.scraper.useBedrock) {
    if (cfg.bedrock.accessKeyId && !cfg.bedrock.secretAccessKey) {
      missing.push("AWS_SECRET_ACCESS_KEY");
    }
    if (!cfg.bedrock.accessKeyId && cfg.bedrock.secretAccessKey) {
      missing.push("AWS_ACCESS_KEY_ID");
    }
  } else {
    if (!cfg.scraper.anthropicApiKey) missing.push("ANTHROPIC_API_KEY");
  }

  if (missing.length === 0) return { ok: true };
  return { ok: false, detail: `missing: ${missing.join(", ")}` };
}

/**
 * Flags back-pressure on the Stagehand task queue. When queue depth
 * (waiting + in-flight) exceeds `readinessQueueThreshold`, orchestrators
 * should stop sending new work — additional requests would just pile
 * onto an already-saturated pool and time out in client SLAs.
 */
function checkScraperPool(
  cfg: HealthConfig,
  stats: () => { size: number; pending: number; concurrency: number }
): DependencyStatus {
  const s = stats();
  const depth = s.size + s.pending;
  if (depth <= cfg.scraper.readinessQueueThreshold) {
    return { ok: true, detail: `depth=${depth}` };
  }
  return {
    ok: false,
    detail: `queue depth ${depth} exceeds threshold ${cfg.scraper.readinessQueueThreshold}`,
  };
}

/**
 * Scans heal-out/<siteId>/healing-<siteId>.md files under `rootDir` and
 * extracts the verdict and best-pass-rate lines written by writeHealReport().
 * Returns an empty object when the heal-out directory doesn't exist yet —
 * the caller treats absence as "no healing runs performed."
 */
function readHealSummaries(rootDir: string): Record<string, HealSummary> {
  const healOut = resolve(join(rootDir, "heal-out"));
  if (!existsSync(healOut)) return {};

  const result: Record<string, HealSummary> = {};
  let siteDirs: string[];
  try {
    siteDirs = readdirSync(healOut, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return {};
  }

  for (const siteId of siteDirs) {
    const reportPath = join(healOut, siteId, `healing-${siteId}.md`);
    if (!existsSync(reportPath)) continue;

    let content: string;
    try {
      content = readFileSync(reportPath, "utf-8");
    } catch {
      continue;
    }

    const verdictMatch = /^\*\*Verdict:\*\*\s+(\S+)/m.exec(content);
    const passRateMatch = /^\*\*Best pass rate:\*\*\s+(\d+)%/m.exec(content);
    if (!verdictMatch) continue;

    const verdict = verdictMatch[1] ?? "UNKNOWN";
    const bestPassRate = passRateMatch ? Number(passRateMatch[1]) / 100 : 0;

    result[siteId] = { verdict, bestPassRate, reportPath: resolve(reportPath) };
  }

  return result;
}

/**
 * Health and readiness probes. Ops-only routes — bypass auth and return plain JSON instead
 * of the standard envelope. `/healthz` is a liveness check (process is up). `/readyz`
 * verifies external dependencies and downgrades to 503 when any are
 * unreachable so orchestrators stop routing traffic.
 *
 * Config is injected so tests can swap in specific states without
 * relying on frozen-at-import process.env.
 */
export async function healthRoutes(
  app: FastifyInstance,
  options: HealthRoutesOptions = {}
): Promise<void> {
  const cfg: HealthConfig = options.config ?? defaultConfig;

  app.get("/healthz", async () => ({ status: "ok" }));

  const poolStatsFn = options.poolStats ?? defaultPoolStats;
  const cacheStatsFn = options.cacheStats ?? defaultCacheStats;
  const telemetryStateFn = options.telemetryState ?? getTelemetryState;
  const healOutRoot = options.healOutRoot ?? process.cwd();

  app.get("/readyz", async (_request, reply: FastifyReply) => {
    const [database, scraperCredentials, scraperPool] = await Promise.all([
      checkDatabase(cfg),
      Promise.resolve(checkScraperCredentials(cfg)),
      Promise.resolve(checkScraperPool(cfg, poolStatsFn)),
    ]);
    const allOk = database.ok && scraperCredentials.ok && scraperPool.ok;
    const report: ReadinessReport = {
      status: allOk ? "ready" : "degraded",
      checks: { database, scraperCredentials, scraperPool },
      stats: {
        scraperPool: poolStatsFn(),
        cache: cacheStatsFn(),
        metrics: allMetrics(),
      },
      telemetry: telemetryStateFn(),
      heal: readHealSummaries(healOutRoot),
    };
    if (!allOk) {
      logger.warn(
        `readyz degraded: db=${database.ok ? "ok" : database.detail} scraperCreds=${scraperCredentials.ok ? "ok" : scraperCredentials.detail} pool=${scraperPool.ok ? "ok" : scraperPool.detail}`
      );
      reply.code(503);
    }
    return report;
  });
}
