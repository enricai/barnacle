import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

/**
 * Full-pipeline regression through the real `recon-generate` CLI: a legitimately-
 * repeated GraphQL search primary shares its endpoint with a SINGLE distinct
 * sibling operation that is re-issued far MORE often than the primary itself —
 * not merely a plurality-but-not-majority shape, but a shape where the
 * primary isn't even the largest same-endpoint group. `hasStableOperationIdentity`
 * must grant the rescue purely from the candidate's own operationName recurring
 * at least twice, with no comparison against other operationName groups'
 * counts. Before that fix, any gate comparing the candidate's group size
 * against other groups would reject this exact shape, leaving `main()` to log
 * "no fold plan resolved" and the generated contract to omit the drilled field.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const GRAPHQL_URL = "https://api.example.com/graphql";
const DRILL_URL = "https://api.example.com/inventory/api/v1/items";

const SEARCH_QUERY = "query catalogSearch { catalogSearch { results { id name } } }";
const SEARCH_CALL_COUNT = 19;
const SIBLING_OPERATION_NAME = "typeahead";
const SIBLING_CALL_COUNT = 31;

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
    // An explicit content-type on the response is required to land on the
    // buggy branch: without it, isZeroVarianceRepeatCapture returns false
    // before ever consulting hasStableOperationIdentity.
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

/**
 * A single distinct sibling operation multiplexed on the same GraphQL
 * endpoint, re-issued MORE often than the primary — the primary's own
 * group is never even the largest at the endpoint, let alone a majority.
 */
function siblingOperationCapture(index: number): unknown {
  const query = `query ${SIBLING_OPERATION_NAME}($term: String!) { ${SIBLING_OPERATION_NAME}(term: $term) { id } }`;
  return {
    timestamp: `2024-01-01T00:01:${String(index).padStart(2, "0")}Z`,
    phase: "browse",
    method: "POST",
    url: GRAPHQL_URL,
    status: 200,
    requestHeaders: { "Content-Type": "application/json" },
    requestPostData: JSON.stringify({ query, variables: { term: `t${index}` } }),
    responseHeaders: { "content-type": "application/json" },
    responseBody: { [SIBLING_OPERATION_NAME]: [{ id: `suggestion-${index}` }] },
    operationName: SIBLING_OPERATION_NAME,
    query,
    variables: { term: `t${index}` },
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

function writeRunDir(root: string): void {
  mkdirSync(join(root, "graphql"), { recursive: true });
  mkdirSync(join(root, "replays"), { recursive: true });
  mkdirSync(join(root, "aux"), { recursive: true });
  writeFileSync(join(root, "replays", "rate-limit.json"), JSON.stringify([]));

  const searchCaptures = Array.from({ length: SEARCH_CALL_COUNT }, (_, i) =>
    graphqlSearchCapture(i)
  );
  // The sibling operation's SINGLE group outnumbers the primary's own group
  // (31 > 19) — the primary is not the largest same-endpoint group, not
  // merely a plurality short of a majority.
  const siblingCaptures = Array.from({ length: SIBLING_CALL_COUNT }, (_, i) =>
    siblingOperationCapture(i)
  );

  // Interleave so the primary's occurrences aren't artificially clustered.
  const interleaved: unknown[] = [];
  let searchCursor = 0;
  let siblingCursor = 0;
  while (searchCursor < searchCaptures.length || siblingCursor < siblingCaptures.length) {
    if (searchCursor < searchCaptures.length) interleaved.push(searchCaptures[searchCursor++]);
    if (siblingCursor < siblingCaptures.length) interleaved.push(siblingCaptures[siblingCursor++]);
    if (siblingCursor < siblingCaptures.length) interleaved.push(siblingCaptures[siblingCursor++]);
  }

  interleaved.forEach((capture, i) => {
    writeFileSync(
      join(root, "graphql", `${String(i).padStart(3, "0")}-browse-search.json`),
      JSON.stringify(capture)
    );
  });
  writeFileSync(
    join(root, "graphql", `${String(interleaved.length).padStart(3, "0")}-browse-drill.json`),
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

describe("recon-generate CLI: a search primary outnumbered by a single sibling operation sharing its GraphQL endpoint resolves the fold plan", () => {
  it("resolves the fold plan and never warns 'no fold plan resolved' when a single sibling operation recurs more often than the primary at the shared endpoint", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-outnumbered-gql-primary-"));
    const runRoot = join(workDir, "run");
    writeRunDir(runRoot);

    const siteId = `outnumbered-gql-primary-test-${process.pid}`;
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
  }, 30_000);
});
