/**
 * Diagnostic probe for AppCast warmup interceptor reliability. Runs N
 * sequential warmup attempts against a single job URL and records per-attempt
 * outcome, session attributes, and timing. The structured report lets us
 * determine whether interceptor-init failures are independent (fixable with
 * more retries) or correlated with specific session attributes (fixable by
 * avoiding those attributes).
 *
 * Usage:
 *   pnpm tsx --env-file=.env src/scripts/probe-warmup-reliability.ts \
 *     --url "https://apply.appcast.io/jobs/<id>/applyboard/apply?..." \
 *     --attempts 20 \
 *     [--delay-between-ms 5000] \
 *     [--report /tmp/warmup-probe-report.json]
 */

import { writeFileSync } from "node:fs";

import { toErrorMessage } from "@/lib/errors";
import { getScriptLogger } from "@/lib/logging";
import { createBrowserbaseBrowserSession } from "@/scraper/session-browserbase";
import { captureTokensFromBrowser } from "@/sites/appcast/tokens/capture";

const logger = getScriptLogger("probe-warmup-reliability");

type Outcome = "success" | "interceptor_failed" | "angular_stalled" | "error";

interface AttemptResult {
  attemptNumber: number;
  outcome: Outcome;
  browserbaseSessionId: string;
  wallClockMs: number;
  hostedAppliesSessionCaptured: boolean;
  xDatadomeClientidLength: number;
  datadomeCookieCaptured: boolean;
  errorMessage: string | null;
}

interface CliArgs {
  url: string;
  attempts: number;
  delayBetweenMs: number;
  reportPath: string;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  const get = (name: string): string | null => {
    const i = args.indexOf(name);
    return i >= 0 && args[i + 1] ? (args[i + 1] ?? null) : null;
  };
  const url = get("--url");
  if (!url) {
    logger.error("--url is required");
    process.exit(1);
  }
  return {
    url,
    attempts: Number(get("--attempts") ?? 20),
    delayBetweenMs: Number(get("--delay-between-ms") ?? 5000),
    reportPath: get("--report") ?? `/tmp/warmup-probe-report-${Date.now()}.json`,
  };
}

function classifyError(msg: string): Outcome {
  const apiReqMatch = msg.match(/after (\d+) api request/);
  if (apiReqMatch) {
    const count = Number(apiReqMatch[1]);
    if (count === 0) return "angular_stalled";
    return "interceptor_failed";
  }
  return "error";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runAttempt(attemptNumber: number, url: string): Promise<AttemptResult> {
  const t0 = Date.now();
  const session = await createBrowserbaseBrowserSession({ advancedStealth: true });
  const sessionId = session.sessionId;
  logger.info(`attempt ${attemptNumber}: sessionId=${sessionId}`);

  try {
    const tokens = await captureTokensFromBrowser(session.stagehand, url, logger);
    return {
      attemptNumber,
      outcome: "success",
      browserbaseSessionId: sessionId,
      wallClockMs: Date.now() - t0,
      hostedAppliesSessionCaptured: tokens.hostedAppliesSession.length > 0,
      xDatadomeClientidLength: tokens.xDatadomeClientid.length,
      datadomeCookieCaptured: tokens.datadomeCookie.length > 0,
      errorMessage: null,
    };
  } catch (err) {
    const msg = toErrorMessage(err);
    return {
      attemptNumber,
      outcome: classifyError(msg),
      browserbaseSessionId: sessionId,
      wallClockMs: Date.now() - t0,
      hostedAppliesSessionCaptured: false,
      xDatadomeClientidLength: 0,
      datadomeCookieCaptured: false,
      errorMessage: msg,
    };
  } finally {
    await session.close().catch((closeErr) => {
      logger.warn(`attempt ${attemptNumber}: close failed: ${toErrorMessage(closeErr)}`);
    });
  }
}

function printSummary(results: AttemptResult[]): void {
  const total = results.length;
  const byOutcome = new Map<Outcome, number>();
  for (const r of results) {
    byOutcome.set(r.outcome, (byOutcome.get(r.outcome) ?? 0) + 1);
  }

  const successes = results.filter((r) => r.outcome === "success");
  const successRate = total > 0 ? ((successes.length / total) * 100).toFixed(1) : "N/A";

  const wallClocks = results.map((r) => r.wallClockMs).sort((a, b) => a - b);
  const p50 = wallClocks[Math.floor(wallClocks.length * 0.5)] ?? 0;
  const p95 = wallClocks[Math.floor(wallClocks.length * 0.95)] ?? 0;
  const mean = total > 0 ? Math.round(wallClocks.reduce((a, b) => a + b, 0) / total) : 0;

  logger.info("=== WARMUP RELIABILITY PROBE SUMMARY ===");
  logger.info(`total attempts: ${total}`);
  logger.info(`success rate: ${successRate}% (${successes.length}/${total})`);
  for (const [outcome, count] of byOutcome) {
    logger.info(`  ${outcome}: ${count} (${((count / total) * 100).toFixed(1)}%)`);
  }
  logger.info(`wall clock: mean=${mean}ms p50=${p50}ms p95=${p95}ms`);
}

async function main(): Promise<void> {
  const args = parseArgs();
  logger.info(
    `starting warmup reliability probe: url=${args.url.slice(0, 120)} attempts=${args.attempts} delay=${args.delayBetweenMs}ms`
  );

  const results: AttemptResult[] = [];
  for (let i = 1; i <= args.attempts; i++) {
    const result = await runAttempt(i, args.url);
    results.push(result);
    logger.info(
      `attempt ${i}/${args.attempts}: ${result.outcome} (${result.wallClockMs}ms) session=${result.browserbaseSessionId}`
    );
    if (i < args.attempts) {
      await sleep(args.delayBetweenMs);
    }
  }

  printSummary(results);

  writeFileSync(args.reportPath, JSON.stringify({ url: args.url, results }, null, 2));
  logger.info(`report written to ${args.reportPath}`);
}

main().catch((err: unknown) => {
  logger.error(`probe-warmup-reliability failed: ${toErrorMessage(err)}`);
  process.exit(1);
});
