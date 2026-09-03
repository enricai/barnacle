import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

/**
 * Reproduces (in miniature) the reported failure end to end through the real
 * `recon-generate` CLI: a read (query) flow whose primary GraphQL operation
 * is captured 3x under different variables/phases, plus one `foldReturn`
 * drill GET. Before the fix, `computeFoldChain` sweeps the later redundant
 * same-operation re-issue into the fold chain whenever its request happens
 * to thread an unechoed response value from an already-chained step — here,
 * the drill leaks `region: "north-metro"` and the 3rd redundant primary
 * capture's own `filter` variable is set to that exact atomic value, which
 * the drill's own request never echoes. That turns a same-operation
 * re-issue into an extra `httpClient(...)` call in the emitted fold-merge
 * block instead of being dropped as redundant.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const SEARCH_QUERY =
  "query catalogSearch($filter: String) { catalogSearch(filter: $filter) { items { id title } } }";
const ITEM_ID = "catalog-item-1";
const DRILL_ENDPOINT = "/catalog/api/v1/details";

function catalogSearchCapture(phase: string, filter: string, timestamp: string): unknown {
  return {
    timestamp,
    phase,
    method: "POST",
    url: "https://example.com/graphql",
    status: 200,
    requestHeaders: { "Content-Type": "application/json" },
    requestPostData: JSON.stringify({ query: SEARCH_QUERY, variables: { filter } }),
    responseHeaders: {},
    responseBody: { catalogSearch: { items: [{ id: ITEM_ID, title: "Catalog Item" }] } },
    operationName: "catalogSearch",
    query: SEARCH_QUERY,
    variables: { filter },
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
    // "region" is leaked here but never echoed anywhere in this capture's
    // own request -- the value the buggy sweep in computeFoldChain latches
    // onto when a LATER capture's request happens to reuse it verbatim.
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
    JSON.stringify(catalogSearchCapture("navigate-to-the-broad-ca", "all", "2024-01-01T00:00:00Z"))
  );
  writeFileSync(
    join(root, "graphql", "001-home.json"),
    JSON.stringify(catalogSearchCapture("home", "all|nights:5", "2024-01-01T00:00:01Z"))
  );
  writeFileSync(
    join(root, "graphql", "002-drill.json"),
    JSON.stringify(detailDrillCapture("2024-01-01T00:00:02Z"))
  );
  writeFileSync(
    join(root, "graphql", "003-click-the-first-item-li.json"),
    // The exact atomic leaked value ("north-metro") from the drill's
    // response, which the drill's own request never echoes -- this is what
    // triggers the buggy forward sweep in computeFoldChain.
    JSON.stringify(
      catalogSearchCapture("click-the-first-item-li", "north-metro", "2024-01-01T00:00:03Z")
    )
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

describe("read-flow redundant same-operation capture dedup — runtime e2e", () => {
  it("emits exactly one primary query call and one folded drill call, not one httpClient call per redundant same-operation re-issue", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-redundant-same-op-"));
    const runRoot = join(workDir, "run");
    writeRunDir(runRoot);

    const siteId = `redundant-same-op-test-run${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    writeFlowFile(siteOutDir);

    const result = run(runRoot, siteId);
    const out = `${result.stdout}\n${result.stderr}`;
    expect(result.status, out).toBe(0);

    const contract = readFileSync(join(siteOutDir, "contract.ts"), "utf8");

    // The primary GraphQL query is fetched once, regardless of how many
    // times the same operation was re-issued under different variables.
    const gqlCallSites = contract.match(/getGql\(context\.baseUrl\)\(/g) ?? [];
    expect(gqlCallSites.length).toBe(1);

    // The drill folds once per its own foldReturn -- not once per redundant
    // same-operation capture swept into the fold chain.
    const httpClientCallSites = contract.match(/await httpClient\(/g) ?? [];
    expect(httpClientCallSites.length).toBe(1);

    // The drill's own endpoint path appears exactly once in the emitted body.
    const drillEndpointOccurrences =
      contract.match(new RegExp(DRILL_ENDPOINT.replace(/\//g, "\\/"), "g")) ?? [];
    expect(drillEndpointOccurrences.length).toBe(1);
  }, 30_000);
});
