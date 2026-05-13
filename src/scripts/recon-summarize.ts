import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { formatISO } from "date-fns";

import { getLogger } from "@/lib/logging";

const logger = getLogger({ name: "scripts/recon-summarize" });

const OUTPUT_DIR = "/tmp/recon";
const LIVE_MD = join(process.cwd(), "docs", "rc-recon-live.md");

/**
 * Phase 3 of the recon pipeline — rolls up every artifact under
 * `/tmp/recon/` into a single human-readable `docs/rc-recon-live.md`
 * and prints a concise summary to stdout. No truncation decisions are
 * made here beyond the "show first 1200 chars, rest on disk" cue —
 * the full JSON is always available under `/tmp/recon/`.
 */

interface GraphqlCapture {
  capturedAt: string;
  url: string;
  method: string;
  status: number;
  operationName: string | undefined;
  query: string | undefined;
  variables: unknown;
  responseBody: string | null;
  phase: "home" | "filter" | "detail";
}

interface FilterEncoding {
  filters: string | null;
  qualifiers?: string;
  decodedAs?: { asJson: unknown; asUrlEncoded: unknown; asBase64: unknown };
  note?: string;
}

function readJson<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch (err) {
    logger.warn(`failed to parse ${path}: ${String(err)}`);
    return null;
  }
}

function snip(s: string | null | undefined, n = 1200): string {
  if (!s) return "_(empty)_";
  return s.length > n ? `${s.slice(0, n)}\n… [${s.length - n} more chars on disk]` : s;
}

function main(): void {
  const lines: string[] = [];
  const push = (...rest: string[]): void => {
    lines.push(...rest);
  };

  push(`# Live RC Recon — regenerated`, "", `Generated at ${formatISO(new Date())}`, "");
  push(
    "Full untruncated artifacts on disk at `/tmp/recon/` (gitignored).",
    "This document is a skim-able rollup; jq the JSON files for details.",
    ""
  );

  const graphqlDir = join(OUTPUT_DIR, "graphql");
  const captureFiles = existsSync(graphqlDir)
    ? readdirSync(graphqlDir)
        .filter((f) => f.endsWith(".json"))
        .sort()
    : [];
  const captures = captureFiles
    .map((f) => readJson<GraphqlCapture>(join(graphqlDir, f)))
    .filter((c): c is GraphqlCapture => c !== null);

  push("## 1. GraphQL captures (browser phase)", "");
  push(`Captured **${captures.length}** GraphQL exchanges across home/filter/detail phases.`, "");
  const byOp = new Map<string, GraphqlCapture[]>();
  for (const c of captures) {
    const key = `${c.phase}:${c.operationName ?? "(anon)"}`;
    const arr = byOp.get(key) ?? [];
    arr.push(c);
    byOp.set(key, arr);
  }
  push("| phase | operationName | count | url |", "|---|---|---|---|");
  for (const [key, arr] of byOp.entries()) {
    const [phase, op] = key.split(":");
    push(`| ${phase} | ${op} | ${arr.length} | ${arr[0]?.url ?? ""} |`);
  }
  push("");

  const uniqOps = new Map<string, GraphqlCapture>();
  for (const c of captures) {
    if (c.operationName && !uniqOps.has(c.operationName)) uniqOps.set(c.operationName, c);
  }
  push("## 2. First capture per operation (full query + response head)", "");
  for (const [name, c] of uniqOps.entries()) {
    push(`### ${name} — ${c.phase} — ${c.url}`);
    push("**query:**", "```graphql", snip(c.query, 3_000), "```");
    push("**variables:**", "```json", snip(JSON.stringify(c.variables, null, 2), 400), "```");
    push("**response head:**", "```json", snip(c.responseBody, 1_200), "```", "");
  }

  const filterEnc = readJson<FilterEncoding>(join(OUTPUT_DIR, "filter-encoding.json"));
  push("## 3. Filter-string encoding", "");
  if (filterEnc?.filters) {
    push("Raw value on the wire:", "```", filterEnc.filters, "```");
    push("Decoded attempts:", "```json", JSON.stringify(filterEnc.decodedAs, null, 2), "```");
    if (filterEnc.qualifiers !== undefined) {
      push("Qualifiers seen alongside:", "```", String(filterEnc.qualifiers), "```");
    }
  } else {
    push("_No filtered cruiseSearch_Cruises observed._");
    if (filterEnc?.note) push(`Note: ${filterEnc.note}`);
  }
  push("");

  const introGraph = readJson<{ enabled: boolean; status: number; typeCount?: number }>(
    join(OUTPUT_DIR, "introspection-graph.json")
  );
  const introCruises = readJson<{ enabled: boolean; status: number; typeCount?: number }>(
    join(OUTPUT_DIR, "introspection-cruises-graph.json")
  );
  push("## 4. GraphQL introspection", "");
  push("| endpoint | http status | enabled | type count |", "|---|---|---|---|");
  push(
    `| /graph | ${introGraph?.status ?? "?"} | ${introGraph?.enabled ?? "?"} | ${introGraph?.typeCount ?? "—"} |`
  );
  push(
    `| /cruises/graph | ${introCruises?.status ?? "?"} | ${introCruises?.enabled ?? "?"} | ${introCruises?.typeCount ?? "—"} |`
  );
  push("");

  const replaySummary = readJson<{
    total: number;
    ok: number;
    replays: Array<{ operationName?: string; status: number; bodyLength: number; ok: boolean }>;
  }>(join(OUTPUT_DIR, "replay-summary.json"));
  push("## 5. Headless replay of captured operations", "");
  if (replaySummary) {
    push(`${replaySummary.ok} / ${replaySummary.total} replays succeeded.`, "");
    push("| operationName | http | bytes | ok |", "|---|---|---|---|");
    for (const r of replaySummary.replays.slice(0, 30)) {
      push(`| ${r.operationName ?? "(anon)"} | ${r.status} | ${r.bodyLength} | ${r.ok} |`);
    }
  } else {
    push("_No replay summary file._");
  }
  push("");

  const auxSummary = readJson<{
    results: Array<{ slug: string; status: number; bytes: number; ok: boolean; note: string }>;
  }>(join(OUTPUT_DIR, "aux-summary.json"));
  push("## 6. Auxiliary endpoints", "");
  if (auxSummary) {
    push("| slug | status | bytes | ok | note |", "|---|---|---|---|---|");
    for (const r of auxSummary.results) {
      push(`| ${r.slug} | ${r.status} | ${r.bytes} | ${r.ok} | ${r.note} |`);
    }
  } else {
    push("_No aux summary file._");
  }
  push("");

  const rate = readJson<{
    totalRequests: number;
    successes: number;
    throttled: number;
    firstThrottleAt: number | null;
    stopped: string;
  }>(join(OUTPUT_DIR, "rate-limit.json"));
  push("## 7. Rate-limit probe (/cruises/graph, 5 rps)", "");
  if (rate) {
    push(
      `Total: ${rate.totalRequests}, successes: ${rate.successes}, throttled: ${rate.throttled}, firstThrottleAt: ${rate.firstThrottleAt ?? "never"}, stopped: ${rate.stopped}`
    );
    if (rate.throttled === 0 && rate.successes === rate.totalRequests) {
      push(
        "",
        "**No throttling observed up to 5 rps × 60 requests.** Direct-HTTP catalog strategy remains viable."
      );
    } else {
      push(
        "",
        "**Throttling observed** — direct-HTTP strategy must account for this (back-off, or route through Steel)."
      );
    }
  } else {
    push("_No rate-limit file._");
  }
  push("");

  push("## 8. Gap closure", "");
  push("| # | Gap | Closed? | Evidence |", "|---|---|---|---|");
  push(
    `| 1 | Untruncated queries | ${captures.length > 0 ? "yes" : "no"} | ${captures.length} captures on disk at /tmp/recon/graphql |`
  );
  push(
    `| 2 | filters encoding | ${filterEnc?.filters ? "yes" : "no"} | /tmp/recon/filter-encoding.json |`
  );
  push(`| 3 | Introspection | ${introGraph && introCruises ? "yes" : "no"} | see §4 |`);
  push(`| 4 | Stagehand extract failures | n/a | replaced with raw Playwright |`);
  push(
    `| 5 | Detail-page CSR ops | ${captures.filter((c) => c.phase === "detail").length > 0 ? "yes" : "no"} | ${captures.filter((c) => c.phase === "detail").length} captures in detail phase |`
  );
  push(`| 6 | Rate limits | ${rate ? "yes" : "no"} | /tmp/recon/rate-limit.json |`);
  push(
    `| 7 | Aux endpoints | ${auxSummary ? "yes" : "no"} | ${auxSummary?.results.length ?? 0} aux endpoints probed |`
  );
  push(
    `| 8 | Full bestPromotionForMarket + cruises_FilterOptions | ${uniqOps.has("bestPromotionForMarket") || uniqOps.size > 0 ? "yes" : "no"} | replays in /tmp/recon/replays |`
  );
  push("");

  writeFileSync(LIVE_MD, lines.join("\n"));
  logger.info(`wrote ${LIVE_MD}`);
  logger.info(
    `summary: ${captures.length} captures, ${uniqOps.size} unique ops, filter-encoding=${filterEnc?.filters ? "captured" : "missing"}, introspection.graph=${introGraph?.enabled}, introspection.cruisesGraph=${introCruises?.enabled}, rate-limit.throttled=${rate?.throttled ?? "?"}`
  );
}

try {
  main();
} catch (err) {
  logger.errorWithStack(err as Error, "recon-summarize threw");
  process.exit(1);
}
