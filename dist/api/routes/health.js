"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.healthRoutes = healthRoutes;
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const response_cache_1 = require("../../cache/response-cache");
const config_1 = require("../../config");
const client_1 = require("../../lib/db/client");
const errors_1 = require("../../lib/errors");
const logging_1 = require("../../lib/logging");
const run_state_1 = require("../../lib/telemetry/run-state");
const metrics_1 = require("../../scraper/metrics");
const pool_1 = require("../../scraper/pool");
const logger = (0, logging_1.getLogger)({ name: "routes/health" });
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
async function checkDatabase(cfg) {
    if (!cfg.databaseUrl) {
        return { ok: true, detail: "DATABASE_URL unset — skipped" };
    }
    // Clear the timeout when prisma resolves so setTimeout can't keep the
    // event loop alive past shutdown, and unref() the timer so a hanging
    // query can't block process.exit during ops drills. The original
    // Promise.race left the timeout live on the happy path and pinned
    // the event loop on the sad path.
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("timeout")), DB_CHECK_TIMEOUT_MS);
        timer.unref();
    });
    try {
        await Promise.race([client_1.prisma.$queryRawUnsafe("SELECT 1"), timeout]);
        return { ok: true };
    }
    catch (err) {
        return { ok: false, detail: (0, errors_1.toErrorMessage)(err).slice(0, 200) };
    }
    finally {
        if (timer)
            clearTimeout(timer);
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
function checkScraperCredentials(cfg) {
    const missing = [];
    if (!cfg.scraper.steelApiKey)
        missing.push("STEEL_API_KEY");
    if (cfg.scraper.useBedrock) {
        if (cfg.bedrock.accessKeyId && !cfg.bedrock.secretAccessKey) {
            missing.push("AWS_SECRET_ACCESS_KEY");
        }
        if (!cfg.bedrock.accessKeyId && cfg.bedrock.secretAccessKey) {
            missing.push("AWS_ACCESS_KEY_ID");
        }
    }
    else {
        if (!cfg.scraper.anthropicApiKey)
            missing.push("ANTHROPIC_API_KEY");
    }
    if (missing.length === 0)
        return { ok: true };
    return { ok: false, detail: `missing: ${missing.join(", ")}` };
}
/**
 * Flags back-pressure on the Stagehand task queue. When queue depth
 * (waiting + in-flight) exceeds `readinessQueueThreshold`, orchestrators
 * should stop sending new work — additional requests would just pile
 * onto an already-saturated pool and time out in client SLAs.
 */
function checkScraperPool(cfg, stats) {
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
function readHealSummaries(rootDir) {
    const healOut = (0, node_path_1.resolve)((0, node_path_1.join)(rootDir, "heal-out"));
    if (!(0, node_fs_1.existsSync)(healOut))
        return {};
    const result = {};
    let siteDirs;
    try {
        siteDirs = (0, node_fs_1.readdirSync)(healOut, { withFileTypes: true })
            .filter((e) => e.isDirectory())
            .map((e) => e.name);
    }
    catch {
        return {};
    }
    for (const siteId of siteDirs) {
        const reportPath = (0, node_path_1.join)(healOut, siteId, `healing-${siteId}.md`);
        if (!(0, node_fs_1.existsSync)(reportPath))
            continue;
        let content;
        try {
            content = (0, node_fs_1.readFileSync)(reportPath, "utf-8");
        }
        catch {
            continue;
        }
        const verdictMatch = /^\*\*Verdict:\*\*\s+(\S+)/m.exec(content);
        const passRateMatch = /^\*\*Best pass rate:\*\*\s+(\d+)%/m.exec(content);
        if (!verdictMatch)
            continue;
        const verdict = verdictMatch[1] ?? "UNKNOWN";
        const bestPassRate = passRateMatch ? Number(passRateMatch[1]) / 100 : 0;
        result[siteId] = { verdict, bestPassRate, reportPath: (0, node_path_1.resolve)(reportPath) };
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
async function healthRoutes(app, options = {}) {
    const cfg = options.config ?? config_1.config;
    app.get("/healthz", async () => ({ status: "ok" }));
    const poolStatsFn = options.poolStats ?? pool_1.poolStats;
    const cacheStatsFn = options.cacheStats ?? response_cache_1.cacheStats;
    const telemetryStateFn = options.telemetryState ?? run_state_1.getTelemetryState;
    const healOutRoot = options.healOutRoot ?? process.cwd();
    app.get("/readyz", async (_request, reply) => {
        const [database, scraperCredentials, scraperPool] = await Promise.all([
            checkDatabase(cfg),
            Promise.resolve(checkScraperCredentials(cfg)),
            Promise.resolve(checkScraperPool(cfg, poolStatsFn)),
        ]);
        const allOk = database.ok && scraperCredentials.ok && scraperPool.ok;
        const report = {
            status: allOk ? "ready" : "degraded",
            checks: { database, scraperCredentials, scraperPool },
            stats: {
                scraperPool: poolStatsFn(),
                cache: cacheStatsFn(),
                metrics: (0, metrics_1.allMetrics)(),
            },
            telemetry: telemetryStateFn(),
            heal: readHealSummaries(healOutRoot),
        };
        if (!allOk) {
            logger.warn(`readyz degraded: db=${database.ok ? "ok" : database.detail} scraperCreds=${scraperCredentials.ok ? "ok" : scraperCredentials.detail} pool=${scraperPool.ok ? "ok" : scraperPool.detail}`);
            reply.code(503);
        }
        return report;
    });
}
//# sourceMappingURL=health.js.map