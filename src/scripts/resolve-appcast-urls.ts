/**
 * One-shot URL resolver for AppCast click-tracking URLs. Reads a TSV of
 * `<jobId>\t<clickUrl>\t<...extra columns>` rows, opens an advancedStealth
 * Browserbase session per row, navigates to the click URL, waits for the
 * JS-side redirect to settle, and emits the resolved `apply.appcast.io`
 * applyboard URL the plugin's Node hot-path requires.
 *
 * Why this exists: Vivian's URL resolution pipeline (`ScrapedJobUrlResolutionCache`)
 * regressed around 2026-06-09 — the applyboard-success rate collapsed from
 * 49% (2026-05-19) to 0% (2026-06-09 onwards). Verified 2026-06-17 by
 * pulling 90 days of daily counts from the cache table; only 1 row across
 * the last 8 days resolved to applyboard. The 51 active UVA Encompass
 * jobs whose cache entries are stuck at `click.appcast.io/t/<token>` are
 * symptomatic, not isolated. This script salvages them by doing the
 * browser-based resolution ourselves with advancedStealth (Vivian's
 * resolver likely lacks).
 *
 * Site-agnostic by design — works on any `click.appcast.io/t/<token>` URL.
 * The output URL shape is what `extractNumericJobId` at
 * `src/sites/appcast/flows/http-flow.ts:37` requires: any URL containing
 * `/jobs/<numericJobId>/`.
 *
 * CLI:
 *   pnpm tsx --env-file=.env src/scripts/resolve-appcast-urls.ts \
 *     --input <path.tsv> --output <path.tsv> [--concurrency N]
 *
 * Input TSV columns (tab-separated):
 *   auditJobId, applyLink, employerName, hospitalCity, hospitalState, jobTitle
 *
 * Output TSV columns:
 *   auditJobId, applyLink, resolvedUrl_or_null, employerName, hospitalCity,
 *   hospitalState, jobTitle, observedFinalUrl
 *
 * Wall clock: ~10s per URL × N URLs / concurrency. Cost: ~$0.50-$1
 * Browserbase per 50 URLs.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";

import PQueue from "p-queue";

import { getScriptLogger } from "@/lib/logging";
import { createBrowserbaseBrowserSession } from "@/scraper/session-browserbase";

const logger = getScriptLogger("resolve-appcast-urls");

interface ClickRow {
  auditJobId: string;
  applyLink: string;
  employerName: string;
  hospitalCity: string;
  hospitalState: string;
  jobTitle: string;
}

interface ResolvedRow extends ClickRow {
  resolvedUrl: string | null;
  observedFinalUrl: string;
}

interface CliArgs {
  inputPath: string;
  outputPath: string;
  concurrency: number;
}

interface RequestWillBeSentEvent {
  requestId: string;
  request: { url: string };
}

/** Parse `--flag value` pairs into a typed args record with sensible defaults. */
function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  const get = (name: string): string | null => {
    const i = args.indexOf(name);
    return i >= 0 && args[i + 1] ? (args[i + 1] ?? null) : null;
  };
  const input = get("--input");
  const output = get("--output");
  if (!input || !output) {
    process.stderr.write(
      "usage: resolve-appcast-urls --input <tsv> --output <tsv> [--concurrency N]\n"
    );
    process.exit(1);
  }
  return {
    inputPath: resolvePath(input),
    outputPath: resolvePath(output),
    concurrency: Number(get("--concurrency") ?? 3),
  };
}

/**
 * Parse a tab-separated input file into typed rows. Skips empty/blank lines
 * but tolerates trailing whitespace from psql --no-align output.
 */
function readInputTsv(path: string): ClickRow[] {
  const lines = readFileSync(path, "utf8").split("\n");
  const rows: ClickRow[] = [];
  for (const line of lines) {
    const trimmed = line.replace(/\r$/, "").trimEnd();
    if (!trimmed) continue;
    const cols = trimmed.split("\t");
    if (cols.length < 6) continue;
    rows.push({
      auditJobId: cols[0] ?? "",
      applyLink: cols[1] ?? "",
      employerName: cols[2] ?? "",
      hospitalCity: cols[3] ?? "",
      hospitalState: cols[4] ?? "",
      jobTitle: cols[5] ?? "",
    });
  }
  return rows;
}

/**
 * Extract the AppCast applyboard URL from a list of observed URLs. Prefers
 * a URL that matches `apply.appcast.io/jobs/<id>/applyboard/apply` directly;
 * falls back to the first `apply.appcast.io/api/jobs/<id>` shape (the API
 * endpoint — we can reconstruct the SPA URL since the numericJobId is what
 * the plugin actually consumes).
 */
function extractApplyboardUrl(observedUrls: string[]): string | null {
  for (const url of observedUrls) {
    if (/apply\.appcast\.io\/jobs\/\d+\/applyboard\/apply/.test(url)) {
      return url;
    }
  }
  for (const url of observedUrls) {
    const m = url.match(/apply\.appcast\.io\/api\/jobs\/(\d+)/);
    if (m) {
      // Reconstruct the SPA shape the plugin's `extractNumericJobId` regex
      // accepts. Preserve the query suffix from the observed URL so cs/exch/jg
      // session tokens survive into the fixture.
      const u = new URL(url);
      const params = u.searchParams.toString();
      return `https://apply.appcast.io/jobs/${m[1]}/applyboard/apply${params ? `?${params}` : ""}`;
    }
  }
  return null;
}

/**
 * Resolve one click URL by opening a Browserbase session, navigating, and
 * capturing the final URL + observed XHR endpoints. The captured `apply.appcast.io`
 * shape is what we feed back into the plugin's existing hot-path.
 *
 * Catches all errors and returns null on failure so the queue keeps going.
 */
async function resolveOne(row: ClickRow): Promise<ResolvedRow> {
  const baseResult: ResolvedRow = {
    ...row,
    resolvedUrl: null,
    observedFinalUrl: "",
  };
  let session: Awaited<ReturnType<typeof createBrowserbaseBrowserSession>> | undefined;
  try {
    session = await createBrowserbaseBrowserSession({ advancedStealth: true });
    const page = await session.stagehand.context.awaitActivePage();
    const cdpSession = page.getSessionForFrame(page.mainFrameId());
    await page.sendCDP("Network.enable", {});

    const observed: string[] = [];
    const onRequest = (params: RequestWillBeSentEvent): void => {
      const url = params.request.url;
      if (url.includes("apply.appcast.io")) observed.push(url);
    };
    cdpSession.on("Network.requestWillBeSent", onRequest);

    try {
      await page.goto(row.applyLink, { waitUntil: "domcontentloaded", timeoutMs: 30_000 });
      // After domcontentloaded, AppCast's Angular bootstrap + DataDome
      // fingerprint resolution + initial XHRs take ~5-10s to settle.
      await page.waitForTimeout(10_000);
      baseResult.observedFinalUrl = page.url();
      const resolved = extractApplyboardUrl([page.url(), ...observed]);
      if (resolved) baseResult.resolvedUrl = resolved;
    } finally {
      cdpSession.off("Network.requestWillBeSent", onRequest);
    }
  } catch (err) {
    logger.warn(
      `resolve failed for ${row.auditJobId.slice(0, 30)}: ${err instanceof Error ? err.message : String(err)}`
    );
  } finally {
    if (session) await session.close().catch(() => undefined);
  }
  return baseResult;
}

/**
 * Format a resolved row as a single output TSV line. Null `resolvedUrl`
 * becomes the literal string "NULL" so downstream grep/awk pipelines can
 * filter cleanly.
 */
function formatOutputRow(r: ResolvedRow): string {
  return [
    r.auditJobId,
    r.applyLink,
    r.resolvedUrl ?? "NULL",
    r.employerName,
    r.hospitalCity,
    r.hospitalState,
    r.jobTitle,
    r.observedFinalUrl,
  ].join("\t");
}

async function main(): Promise<void> {
  const args = parseArgs();
  const rows = readInputTsv(args.inputPath);
  logger.info(
    `read ${rows.length} rows from ${args.inputPath}; resolving with concurrency=${args.concurrency}`
  );
  if (rows.length === 0) {
    logger.error("no rows to resolve; aborting");
    process.exit(1);
  }
  const queue = new PQueue({ concurrency: args.concurrency });
  const results: ResolvedRow[] = await Promise.all(
    rows.map((row) => queue.add(() => resolveOne(row)))
  ).then((rs) => rs.filter((r): r is ResolvedRow => r != null));

  writeFileSync(args.outputPath, `${results.map(formatOutputRow).join("\n")}\n`);
  const successCount = results.filter((r) => r.resolvedUrl !== null).length;
  logger.info(
    `wrote ${results.length} rows to ${args.outputPath}; resolved ${successCount}/${results.length} to applyboard`
  );
  process.stdout.write(
    `\nYield: ${successCount}/${results.length} resolved (${((successCount / results.length) * 100).toFixed(0)}%)\n\n`
  );
}

main().catch((err: unknown) => {
  logger.error(`fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
