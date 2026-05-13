import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { formatISO } from "date-fns";

import { getLogger } from "@/lib/logging";

const logger = getLogger({ name: "scripts/recon-filter-probe-v2" });

const OUTPUT = "/tmp/recon";
const ENDPOINT = "https://www.royalcaribbean.com/cruises/graph";
const QUERY =
  "query cruiseSearch_Cruises($filters:String,$qualifiers:String,$sort:CruiseSearchSort,$pagination:CruiseSearchPagination){cruiseSearch(filters:$filters,qualifiers:$qualifiers,sort:$sort,pagination:$pagination){results{cruises{id productViewLink}total}}}";

const HEADERS: Record<string, string> = {
  "content-type": "application/json",
  accept: "application/json",
  origin: "https://www.royalcaribbean.com",
  referer: "https://www.royalcaribbean.com/cruises",
  "user-agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36",
};

/**
 * V2 probe that validates two hypotheses from v1:
 *   H1: `::` is the multi-key AND separator. Test by running a matrix
 *       of known-narrowing single filters composed with `::` and
 *       verifying the result is consistent with a set intersection.
 *   H2: `~` is the range separator. Test with nights + startDate
 *       ranges of varying widths, asserting monotonic growth as the
 *       range widens.
 *
 * Each probe runs 5x (not 3x) to beat the noise observed in v1, where
 * baseline itself drifted 822..1006. "Stable" is required across all 5
 * repeats here.
 */

interface ProbeResult {
  filters: string;
  repeats: number[];
  stable: boolean;
  total: number | null;
}

async function fetchTotal(filters: string): Promise<number | null> {
  const body = JSON.stringify({
    operationName: "cruiseSearch_Cruises",
    query: QUERY,
    variables: {
      filters,
      qualifiers: "",
      sort: { by: "RECOMMENDED" },
      pagination: { count: 1, skip: 0 },
    },
  });
  try {
    const response = await fetch(ENDPOINT, { method: "POST", headers: HEADERS, body });
    const json = (await response.json()) as {
      data?: { cruiseSearch?: { results?: { total?: number } } };
    };
    return json.data?.cruiseSearch?.results?.total ?? null;
  } catch (err) {
    logger.warn(`probe failed for filters=[${filters}]: ${String(err)}`);
    return null;
  }
}

async function probe(filters: string, repeats = 5): Promise<ProbeResult> {
  const results: number[] = [];
  for (let i = 0; i < repeats; i += 1) {
    const total = await fetchTotal(filters);
    results.push(total ?? -1);
    await new Promise((r) => setTimeout(r, 600));
  }
  const first = results[0] ?? -1;
  const stable = results.every((t) => t === first);
  return { filters, repeats: results, stable, total: stable ? first : null };
}

async function main(): Promise<void> {
  mkdirSync(OUTPUT, { recursive: true });
  logger.info("probing v2 — validating :: AND separator + ~ range separator");
  const toTest = [
    // Known single-predicate baselines (should be stable).
    "destination:CARIB",
    "destination:BAHAM",
    "destination:ALCAN",
    "ship:WN",
    "ship:IC",
    "departurePort:MIA",
    "departurePort:FLL",
    "nights:7~7",
    "nights:3~5",
    "nights:7~10",
    "startDate:2026-06-01~2026-08-31",
    "startDate:2026-06-01~2026-06-30",
    "startDate:2026-01-01~2027-12-31",
    // H1: `::` AND composition.
    "destination:CARIB::nights:7~7",
    "destination:BAHAM::nights:3~5",
    "destination:BAHAM::departurePort:MIA",
    "destination:CARIB::ship:WN",
    "destination:CARIB::departurePort:MIA",
    "departurePort:MIA::nights:7~7",
    "destination:CARIB::startDate:2026-06-01~2026-08-31",
    "destination:CARIB::ship:IC::nights:7~7",
    // Also try with a leading separator (some SPA frameworks do this).
    "::destination:CARIB::nights:7~7",
    // And with internal spaces trimmed different ways.
    "destination:CARIB ::nights:7~7",
    "destination:CARIB:: nights:7~7",
  ];

  const results: ProbeResult[] = [];
  for (const filt of toTest) {
    const r = await probe(filt, 5);
    results.push(r);
    logger.info(
      `${filt.slice(0, 55).padEnd(55)} repeats=${JSON.stringify(r.repeats).padEnd(30)} stable=${r.stable} total=${r.total ?? "-"}`
    );
  }

  const output = {
    capturedAt: formatISO(new Date()),
    endpoint: ENDPOINT,
    hypothesesTested: {
      h1_doubleColon_is_and: "Tested via destination::X + destination::ship pairs.",
      h2_tilde_is_range:
        "Tested via nights:7~7, nights:3~5, nights:7~10, startDate:YYYY-MM-DD~YYYY-MM-DD.",
    },
    results,
  };
  writeFileSync(join(OUTPUT, "filter-probe-matrix-v2.json"), JSON.stringify(output, null, 2));
  logger.info("wrote filter-probe-matrix-v2.json");

  const stable = results.filter((r) => r.stable && r.total !== null && r.total !== undefined);
  logger.info(`${stable.length}/${results.length} probes were stable across 5 repeats`);
  for (const r of stable) {
    logger.info(`  ✓ ${r.filters} → ${r.total}`);
  }
}

void main().catch((err) => {
  logger.errorWithStack(err, "recon-filter-probe-v2 threw");
  process.exit(1);
});
