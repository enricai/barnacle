import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { formatISO } from "date-fns";

import { getLogger } from "@/lib/logging";

const logger = getLogger({ name: "scripts/recon-filter-probe" });

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
 * Pure-HTTP matrix probe for RC's `$filters` string encoding, attacking
 * the multi-key AND composition gap documented in docs/rc-recon.md.
 *
 * Prior recon confirmed `key:value` single-predicate works and
 * `key:v1,v2` is within-key OR, but every multi-key separator tried
 * either collapsed to one predicate or returned 0. This script varies
 * (a) range-filter encodings (`nights`, `startDate`) — which should
 * differ from list filters — and (b) AND-composition separators,
 * running each probe 3x and accepting only results that are stable
 * AND narrow the baseline.
 */

interface ProbeResult {
  filters: string;
  qualifiers: string;
  repeats: number[];
  stable: boolean;
  mean: number;
  baselineDiff: number;
}

async function fetchTotal(filters: string, qualifiers = ""): Promise<number | null> {
  const body = JSON.stringify({
    operationName: "cruiseSearch_Cruises",
    query: QUERY,
    variables: {
      filters,
      qualifiers,
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

async function probe(filters: string, repeats = 3, qualifiers = ""): Promise<ProbeResult> {
  const results: number[] = [];
  for (let i = 0; i < repeats; i += 1) {
    const total = await fetchTotal(filters, qualifiers);
    results.push(total ?? -1);
    await new Promise((r) => setTimeout(r, 800));
  }
  const first = results[0] ?? -1;
  const stable = results.every((t) => t === first);
  const mean = results.reduce((a, b) => a + b, 0) / Math.max(1, results.length);
  return {
    filters,
    qualifiers,
    repeats: results,
    stable,
    mean,
    baselineDiff: 0,
  };
}

async function main(): Promise<void> {
  mkdirSync(OUTPUT, { recursive: true });
  logger.info("calibrating baseline (unfiltered × 3)");
  const baseline = await probe("", 3);
  logger.info(`baseline repeats=${JSON.stringify(baseline.repeats)} stable=${baseline.stable}`);

  // Range-filter candidate encodings (tried alone first).
  const rangeCandidates = [
    "nights:7",
    "nights:7,7",
    "nights:7-7",
    "nights:7..7",
    "nights:7~7",
    "nights:[7,7]",
    "nights:{min:7,max:7}",
    "nights:7to7",
    "nights:min7max7",
    "nights:7-10",
    "nights:7..10",
    "nights:3-5",
    "startDate:2026-06-01..2026-08-31",
    "startDate:2026-06-01-2026-08-31",
    "startDate:2026-06-01,2026-08-31",
    "startDate:2026-06-01~2026-08-31",
    "startDate:[2026-06-01,2026-08-31]",
  ];

  // AND-composition separator candidates (list+list and list+range).
  const andSeparators = [";", "&", "|", "+", " ", "&&", "||", "::", "//", "|||", "\t", "\n"];
  const andCandidates: string[] = [];
  for (const sep of andSeparators) {
    andCandidates.push(`destination:CARIB${sep}ship:WN`);
    andCandidates.push(`destination:CARIB${sep}nights:7`);
    andCandidates.push(`destination:BAHAM${sep}departurePort:MIA`);
  }
  andCandidates.push(
    // Space-separated key:value pairs inside the string — common SPA pattern.
    "destination:CARIB ship:IC",
    "departurePort:MIA destination:BAHAM"
  );

  const all = [...rangeCandidates, ...andCandidates];

  logger.info(`probing ${all.length} candidate encodings × 3 repeats`);
  const probes: ProbeResult[] = [];
  for (const filt of all) {
    const r = await probe(filt, 3);
    r.baselineDiff = baseline.mean - r.mean;
    probes.push(r);
    logger.info(
      `filt=${filt.slice(0, 60).padEnd(60)} repeats=${JSON.stringify(r.repeats).padEnd(20)} stable=${r.stable} Δbase=${r.baselineDiff.toFixed(0)}`
    );
  }

  // A "working" encoding is stable across repeats AND narrows the
  // result materially (> 50 cruises less than baseline mean). "Unstable
  // but narrowing" is also interesting — flag separately.
  const working = probes.filter((p) => p.stable && p.baselineDiff > 50);
  const narrowingButNoisy = probes.filter(
    (p) => !p.stable && p.mean > 0 && p.mean < baseline.mean - 50
  );
  const collapsed = probes.filter((p) => Math.abs(baseline.mean - p.mean) <= 50);

  const output = {
    capturedAt: formatISO(new Date()),
    endpoint: ENDPOINT,
    baseline,
    totalCandidatesProbed: probes.length,
    summary: {
      workingCount: working.length,
      narrowingButNoisyCount: narrowingButNoisy.length,
      collapsedCount: collapsed.length,
    },
    working,
    narrowingButNoisy,
    collapsed,
    allProbes: probes,
  };
  writeFileSync(join(OUTPUT, "filter-probe-matrix.json"), JSON.stringify(output, null, 2));
  logger.info(
    `done: working=${working.length}, narrowingButNoisy=${narrowingButNoisy.length}, collapsed=${collapsed.length}`
  );
  for (const w of working.slice(0, 10)) {
    logger.info(
      `  ✓ stable narrowing: "${w.filters}" → ${w.repeats[0]} (baseline ${baseline.mean})`
    );
  }
}

void main().catch((err) => {
  logger.errorWithStack(err, "recon-filter-probe threw");
  process.exit(1);
});
