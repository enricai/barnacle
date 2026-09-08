import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

/**
 * Reproduces (in miniature) the reported failure end to end through the real
 * `recon-generate` CLI: a read (query) flow whose primary GraphQL operation is
 * re-issued at the same endpoint under a different (aliased) parsed operation
 * name -- but with a response body whose top-level array shape matches the
 * primary's -- alongside one genuinely distinct `foldReturn` drill GET.
 * Before the fix, `dedupRedundantSameOperationCaptures` only grouped captures
 * by `operationGroupKey`, so an aliased re-issue (different operation name,
 * same endpoint, same response shape) survived dedup and was emitted as its
 * own redundant `httpClient` call instead of collapsing into the primary.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const PRIMARY_QUERY =
  "query catalogSearch($filter: String) { catalogSearch(filter: $filter) { items { id title } } }";
// A same-endpoint re-issue of the logical same read, parsed under a
// different operation name (the alias case) but whose response resolves to
// the same object-array shape as the primary's.
const ALIASED_QUERY =
  "query catalogSearch_Alias($filter: String) { catalogSearch(filter: $filter) { items { id title } } }";
const ITEM_ID = "catalog-item-1";
const DRILL_ENDPOINT = "/catalog/api/v1/details";

function catalogSearchCapture(
  phase: string,
  query: string,
  operationName: string,
  timestamp: string
): unknown {
  return {
    timestamp,
    phase,
    method: "POST",
    url: "https://example.com/graphql",
    status: 200,
    requestHeaders: { "Content-Type": "application/json" },
    requestPostData: JSON.stringify({ query, variables: { filter: "all" } }),
    responseHeaders: {},
    responseBody: { catalogSearch: { items: [{ id: ITEM_ID, title: "Catalog Item" }] } },
    operationName,
    query,
    variables: { filter: "all" },
    decodedParams: null,
  };
}

function detailDrillCapture(timestamp: string): unknown {
  return {
    timestamp,
    phase: "drill",
    method: "GET",
    url: `https://example.com${DRILL_ENDPOINT}?id=${ITEM_ID}`,
    status: 200,
    requestHeaders: {},
    requestPostData: null,
    responseHeaders: {},
    responseBody: { detail: [{ id: ITEM_ID, region: "north-metro" }] },
    operationName: null,
    query: null,
    variables: null,
    decodedParams: null,
  };
}

function writeRunDir(root: string): void {
  mkdirSync(join(root, "graphql"), { recursive: true });
  mkdirSync(join(root, "replays"), { recursive: true });
  mkdirSync(join(root, "aux"), { recursive: true });
  writeFileSync(
    join(root, "graphql", "000-navigate-to-the-broad-ca.json"),
    JSON.stringify(
      catalogSearchCapture(
        "navigate-to-the-broad-ca",
        PRIMARY_QUERY,
        "catalogSearch",
        "2024-01-01T00:00:00Z"
      )
    )
  );
  // Same endpoint, same response shape as the primary, but captured under a
  // different (aliased) parsed operation name -- and positioned BEFORE the
  // drill so an undeduped survivor is itself scanned as a rival primary
  // independently threading the same drill capture, per
  // detectDrillDownFoldPlan/buildFoldPlanFromSpec's per-primaryStepIndex
  // scan. Must collapse into the primary rather than surviving as its own
  // httpClient call.
  writeFileSync(
    join(root, "graphql", "001-home.json"),
    JSON.stringify(
      catalogSearchCapture("home", ALIASED_QUERY, "catalogSearch_Alias", "2024-01-01T00:00:01Z")
    )
  );
  writeFileSync(
    join(root, "graphql", "002-drill.json"),
    JSON.stringify(detailDrillCapture("2024-01-01T00:00:02Z"))
  );
}

function writeFlowFile(siteOutDir: string): void {
  mkdirSync(siteOutDir, { recursive: true });
  const flow: Record<string, unknown> = {
    steps: [{ step: "search the catalog" }],
    foldReturn: {
      endpointPattern: DRILL_ENDPOINT,
      resultsPath: "catalogSearch.items",
      drillResultsPath: "detail",
      joinFields: ["id"],
    },
  };
  writeFileSync(join(siteOutDir, "recon-flow.json"), JSON.stringify(flow));
}

let workDir: string | null = null;
let siteOutDir: string | null = null;

afterEach(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
  if (siteOutDir) rmSync(siteOutDir, { recursive: true, force: true });
  workDir = null;
  siteOutDir = null;
});

function run(runRoot: string, siteId: string): ReturnType<typeof spawnSync> {
  return spawnSync(
    TSX_BIN,
    [GENERATE_SCRIPT, "--site-id", siteId, "--run-dir", runRoot, "--emit", "ts", "--force"],
    { cwd: REPO_ROOT, encoding: "utf8" }
  );
}

describe("read-flow aliased operation name, same-endpoint shape dedup — runtime e2e", () => {
  it("collapses the aliased same-endpoint re-issue into the primary read instead of emitting a second httpClient call", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-aliased-op-"));
    const runRoot = join(workDir, "run");
    writeRunDir(runRoot);

    const siteId = `aliased-op-test-run${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    writeFlowFile(siteOutDir);

    const result = run(runRoot, siteId);
    const out = `${result.stdout}\n${result.stderr}`;
    expect(result.status, out).toBe(0);

    const contract = readFileSync(join(siteOutDir, "contract.ts"), "utf8");

    // The primary GraphQL query is fetched once, regardless of the aliased
    // same-endpoint, same-shape re-issue under a different operation name.
    const gqlCallSites = contract.match(/getGql\(context\.baseUrl\)\(/g) ?? [];
    expect(gqlCallSites.length).toBe(1);

    // The drill folds once, for its own genuinely distinct foldReturn -- the
    // aliased duplicate of the primary's own endpoint contributes zero.
    const httpClientCallSites = contract.match(/await httpClient\(/g) ?? [];
    expect(httpClientCallSites.length).toBe(1);

    // The drill's own endpoint path appears exactly once in the emitted body
    // -- not a second time inside the drill's fold-merge block as a stray
    // primary-endpoint duplicate.
    const drillEndpointOccurrences =
      contract.match(new RegExp(DRILL_ENDPOINT.replace(/\//g, "\\/"), "g")) ?? [];
    expect(drillEndpointOccurrences.length).toBe(1);
  }, 30_000);
});
