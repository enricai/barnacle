import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

/**
 * Full-pipeline regression through the real `recon-generate` CLI, at
 * production capture-archive scale: a genuinely repeated GraphQL search
 * primary (stable `operationName`, dense repeat count, varying
 * variables/results per call) shares its single endpoint with hundreds of
 * concurrently-multiplexed one-off GraphQL operations — the shape a real
 * production capture archive produces once every widget on a page fires its
 * own query through the same gateway, at a scale none of the narrower
 * fixtures (a single repeated primary alone, or a repeated primary against
 * a couple dozen siblings) exercise together. Before the fix, this volume
 * of concurrently-multiplexed same-endpoint traffic could tip the primary's
 * own operationName group out of contention entirely, so it fell through to
 * the freely-varying-response noise check and was dropped from the fold
 * candidate pool, leaving `main()` to log "no fold plan resolved" and the
 * generated contract to omit the drilled field.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const GRAPHQL_URL = "https://api.example.com/graphql";
const DRILL_URL = "https://api.example.com/inventory/api/v1/items";

const SEARCH_QUERY = "query catalogSearch { catalogSearch { results { id name } } }";
const SEARCH_CALL_COUNT = 19;

// A wide spread of distinct one-off operation names sharing GRAPHQL_URL,
// mirroring how a schema-stitched gateway multiplexes every widget on a
// page through a single endpoint. 240 distinct operations, each firing
// between 1 and 12 times, produces roughly 1,500 sibling captures — a
// production-archive-scale volume of concurrent same-endpoint traffic none
// of the narrower fixtures reach.
const OTHER_OPERATION_COUNT = 240;

// One sibling widget outfires the search primary itself (25 > the
// primary's 19), the exact production-scale shape that used to sink
// `hasStableOperationIdentity`'s plurality gate: a real archive with
// hundreds of concurrently-multiplexed operations makes it entirely
// plausible for some other single widget to recur even more densely than
// the actual search primary, even though that widget's own recurrence says
// nothing about whether the primary's is real.
const OUT_MULTIPLYING_OPERATION_NAME = "getFeatureFlagsRefresh";
const OUT_MULTIPLYING_OPERATION_COUNT = 25;

function graphqlSearchCapture(index: number): unknown {
  return {
    timestamp: `2024-01-01T00:00:${String(index).padStart(2, "0")}Z`,
    phase: "browse",
    method: "POST",
    url: GRAPHQL_URL,
    status: 200,
    requestHeaders: { "Content-Type": "application/json" },
    requestPostData: JSON.stringify({
      query: SEARCH_QUERY,
      variables: { page: index + 1 },
    }),
    responseHeaders: { "content-type": "application/json" },
    // Zero-padded to a fixed width so every occurrence's response is the
    // same byte length regardless of digit count — otherwise the primary-
    // operation scorer's size signal breaks ties toward a double-digit
    // occurrence instead of the first (page 1), and the drill capture below
    // (which joins on page 1's item id) would silently stop matching.
    responseBody: {
      catalogSearch: {
        results: [
          {
            id: `sku-${String(index).padStart(2, "0")}-a`,
            name: `Widget ${String(index).padStart(2, "0")} A`,
          },
          {
            id: `sku-${String(index).padStart(2, "0")}-b`,
            name: `Widget ${String(index).padStart(2, "0")} B`,
          },
        ],
      },
    },
    // A stable operationName carried by the call itself is real-call
    // evidence: without it, 19 distinct per-page responses read as
    // freely-varying noise and the whole repeated primary is excluded from
    // the fold candidate pool.
    operationName: "catalogSearch",
    query: SEARCH_QUERY,
    variables: { page: index + 1 },
    decodedParams: null,
  };
}

/** A one-off operation sharing the same GraphQL endpoint as the primary, firing a handful of times. */
function otherOperationCapture(operationName: string, occurrence: number, index: number): unknown {
  const query = `query ${operationName} { ${operationName} { id } }`;
  return {
    timestamp: `2024-01-01T00:01:${String(index % 60).padStart(2, "0")}Z`,
    phase: "browse",
    method: "POST",
    url: GRAPHQL_URL,
    status: 200,
    requestHeaders: { "Content-Type": "application/json" },
    requestPostData: JSON.stringify({ query, variables: { occurrence } }),
    responseHeaders: {},
    responseBody: { [operationName]: { id: `${operationName}-${occurrence}` } },
    operationName,
    query,
    variables: { occurrence },
    decodedParams: null,
  };
}

function restDrillDownCapture(): unknown {
  return {
    timestamp: "2024-01-01T00:00:20Z",
    phase: "browse",
    method: "GET",
    url: `${DRILL_URL}?id=sku-00-a`,
    status: 200,
    requestHeaders: {},
    requestPostData: null,
    responseHeaders: {},
    responseBody: { items: [{ id: "sku-00-a", qty: 7 }] },
    operationName: null,
    query: null,
    variables: null,
    decodedParams: null,
  };
}

function buildOtherCaptures(): unknown[] {
  const regularCaptures = Array.from(
    { length: OTHER_OPERATION_COUNT },
    (_, opIndex) => opIndex
  ).flatMap((opIndex) => {
    const operationName = `getWidgetData${opIndex}`;
    const occurrenceCount = (opIndex % 12) + 1;
    return Array.from({ length: occurrenceCount }, (_, occurrence) =>
      otherOperationCapture(operationName, occurrence, opIndex * 12 + occurrence)
    );
  });
  const outMultiplyingCaptures = Array.from(
    { length: OUT_MULTIPLYING_OPERATION_COUNT },
    (_, occurrence) =>
      otherOperationCapture(
        OUT_MULTIPLYING_OPERATION_NAME,
        occurrence,
        OTHER_OPERATION_COUNT * 12 + occurrence
      )
  );
  return [...regularCaptures, ...outMultiplyingCaptures];
}

function writeRunDir(root: string): void {
  mkdirSync(join(root, "graphql"), { recursive: true });
  mkdirSync(join(root, "replays"), { recursive: true });
  mkdirSync(join(root, "aux"), { recursive: true });
  writeFileSync(join(root, "replays", "rate-limit.json"), JSON.stringify([]));

  const searchCaptures = Array.from({ length: SEARCH_CALL_COUNT }, (_, i) =>
    graphqlSearchCapture(i)
  );
  const otherCaptures = buildOtherCaptures();

  // Interleave so the primary's occurrences aren't artificially clustered
  // relative to the mass of concurrently-multiplexed sibling operations,
  // the way a real capture archive's chronological ordering would produce.
  const interleaved: unknown[] = [];
  let searchCursor = 0;
  let otherCursor = 0;
  const otherPerSearch = Math.ceil(otherCaptures.length / searchCaptures.length);
  while (searchCursor < searchCaptures.length || otherCursor < otherCaptures.length) {
    if (searchCursor < searchCaptures.length) interleaved.push(searchCaptures[searchCursor++]);
    for (let i = 0; i < otherPerSearch && otherCursor < otherCaptures.length; i++) {
      interleaved.push(otherCaptures[otherCursor++]);
    }
  }

  interleaved.forEach((capture, i) => {
    writeFileSync(
      join(root, "graphql", `${String(i).padStart(4, "0")}-browse-search.json`),
      JSON.stringify(capture)
    );
  });
  writeFileSync(
    join(root, "graphql", `${String(interleaved.length).padStart(4, "0")}-browse-drill.json`),
    JSON.stringify(restDrillDownCapture())
  );
}

function writeFlowFile(siteOutDir: string): void {
  mkdirSync(siteOutDir, { recursive: true });
  writeFileSync(
    join(siteOutDir, "recon-flow.json"),
    JSON.stringify({
      steps: [{ step: "search for products" }],
      foldReturn: {
        endpointPattern: "/inventory/api/v1/items",
        resultsPath: "catalogSearch.results",
        drillResultsPath: "items",
        joinFields: ["id"],
      },
    })
  );
}

function runGenerate(siteId: string, runRoot: string): ReturnType<typeof spawnSync> {
  return spawnSync(
    TSX_BIN,
    [GENERATE_SCRIPT, "--site-id", siteId, "--run-dir", runRoot, "--emit", "ts", "--force"],
    { cwd: REPO_ROOT, encoding: "utf8" }
  );
}

let workDir: string | null = null;
let siteOutDir: string | null = null;

afterEach(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
  if (siteOutDir) rmSync(siteOutDir, { recursive: true, force: true });
  workDir = null;
  siteOutDir = null;
});

describe("recon-generate CLI: a real GraphQL search primary survives the fold candidate pool at production capture-archive scale", () => {
  it("resolves the fold plan and never warns 'no fold plan resolved' when the primary shares its endpoint with hundreds of concurrently-multiplexed one-off operations", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-production-scale-gql-primary-"));
    const runRoot = join(workDir, "run");
    writeRunDir(runRoot);

    const siteId = `production-scale-gql-primary-test-${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    writeFlowFile(siteOutDir);

    const result = runGenerate(siteId, runRoot);
    const out = `${result.stdout}\n${result.stderr}`;

    expect(result.status, out).toBe(0);
    expect(out).not.toContain("no fold plan resolved");

    const contract = readFileSync(join(siteOutDir, "contract.ts"), "utf8");

    expect(contract).toContain("catalogSearch");
    expect(contract).toContain("/inventory/api/v1/items");
    expect(contract).toContain("qty");
  }, 60_000);
});
