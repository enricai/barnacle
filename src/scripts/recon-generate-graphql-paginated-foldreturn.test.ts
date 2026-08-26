import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

/**
 * Reproduces the reported failure end to end through the real `recon-generate`
 * CLI: a GraphQL query-primary whose response ALSO exposes a bounded-paging
 * signal (a `total` field alongside a `skip`/`count` pagination variable —
 * see `detectPaginationSignal`) plus a declared `foldReturn` that resolves
 * against a later captured GET drill-down. Before the fix, `emitContractTs`'s
 * `singlePrimaryFoldPlans` was unconditionally zeroed whenever a pagination
 * signal was also detected for the same primary op, silently discarding the
 * resolved fold plan — the emitted contract came out byte-identical to one
 * generated with no foldReturn at all, and the "no fold plan resolved"
 * diagnostic never fired because it recomputed plan resolution independently
 * of that pagination exclusion.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const SEARCH_QUERY =
  "query listingSearch($pagination: PaginationInput) { listingSearch(pagination: $pagination) { total items { id title } } }";

/** 2 listing-style item objects, each with a bare `id` identity field. */
function makeListingPage(count: number, offset: number): Record<string, unknown>[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `listing-${offset + i}`,
    title: `Listing ${offset + i}`,
  }));
}

function listingSearchCapture(): unknown {
  return {
    timestamp: "2024-01-01T00:00:00Z",
    phase: "browse",
    method: "POST",
    url: "https://example.com/graphql",
    status: 200,
    requestHeaders: { "Content-Type": "application/json" },
    requestPostData: JSON.stringify({
      query: SEARCH_QUERY,
      variables: { pagination: { count: 2, skip: 0 } },
    }),
    responseHeaders: {},
    responseBody: { listingSearch: { total: 4, items: makeListingPage(2, 1) } },
    operationName: "listingSearch",
    query: SEARCH_QUERY,
    variables: { pagination: { count: 2, skip: 0 } },
    decodedParams: null,
  };
}

function restDrillDownCapture(): unknown {
  return {
    timestamp: "2024-01-01T00:00:01Z",
    phase: "browse",
    method: "GET",
    url: "https://example.com/listings/api/v1/detail?id=listing-1",
    status: 200,
    requestHeaders: {},
    requestPostData: null,
    responseHeaders: {},
    responseBody: { detail: [{ id: "listing-1", sqft: 500 }] },
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
    join(root, "graphql", "000-browse-search.json"),
    JSON.stringify(listingSearchCapture())
  );
  writeFileSync(
    join(root, "graphql", "001-browse-drill.json"),
    JSON.stringify(restDrillDownCapture())
  );
}

function writeFlowFile(siteOutDir: string, opts: { withFoldReturn: boolean }): void {
  mkdirSync(siteOutDir, { recursive: true });
  const flow: Record<string, unknown> = {
    steps: [{ step: "search for listings" }],
  };
  if (opts.withFoldReturn) {
    flow.foldReturn = {
      endpointPattern: "/listings/api/v1/detail",
      resultsPath: "listingSearch.items",
      drillResultsPath: "detail",
      joinFields: ["id"],
    };
  }
  writeFileSync(join(siteOutDir, "recon-flow.json"), JSON.stringify(flow));
}

let workDir: string | null = null;
let siteOutDirWith: string | null = null;
let siteOutDirWithout: string | null = null;

afterEach(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
  if (siteOutDirWith) rmSync(siteOutDirWith, { recursive: true, force: true });
  if (siteOutDirWithout) rmSync(siteOutDirWithout, { recursive: true, force: true });
  workDir = null;
  siteOutDirWith = null;
  siteOutDirWithout = null;
});

function run(runRoot: string, siteId: string): ReturnType<typeof spawnSync> {
  return spawnSync(
    TSX_BIN,
    [GENERATE_SCRIPT, "--site-id", siteId, "--run-dir", runRoot, "--emit", "ts", "--force"],
    { cwd: REPO_ROOT, encoding: "utf8" }
  );
}

describe("GraphQL query-primary + pagination signal + declared foldReturn — runtime e2e", () => {
  it("threads the resolved fold plan into the paginated fetch loop, with no dropped-diagnostic warning", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-gql-paginated-fold-"));
    const runRoot = join(workDir, "run");
    writeRunDir(runRoot);

    const siteId = `gql-paginated-fold-test-run${process.pid}`;
    siteOutDirWith = join(REPO_ROOT, "src", "sites", siteId);
    writeFlowFile(siteOutDirWith, { withFoldReturn: true });

    const result = run(runRoot, siteId);
    const out = `${result.stdout}\n${result.stderr}`;

    expect(result.status, out).toBe(0);
    // The root-cause fix: a resolved plan must not be silently dropped, and
    // the diagnostic (now driven by the same resolved-and-applied plan set
    // the emitter uses) must not fire a false "no fold plan resolved".
    expect(out).not.toContain("no fold plan resolved");

    const contract = readFileSync(join(siteOutDirWith, "contract.ts"), "utf8");

    // Still a real bounded-paging loop, not the single-fixed-page fallback.
    expect(contract).toContain("const PAGE_SIZE = 2;");
    expect(contract).toContain("itemsById");
    expect(contract).toContain("MAX_PAGES");

    // The drill-down call/merge machinery, threaded additively into the
    // paginated loop against the final de-duplicated item set.
    expect(contract).toContain("/listings/api/v1/detail");
    expect(contract).toContain("const foldItems = [...itemsById.values()];");
    expect(contract).toContain("for (const item of foldItems) {");
    expect(contract).toContain("httpClient(");
    // The fold loop must run AFTER the fetch loop has finished merging pages
    // (against the final assembled set), not before `itemsById` exists.
    expect(contract.indexOf("for (const item of foldItems) {")).toBeGreaterThan(
      contract.indexOf("skip += PAGE_SIZE;")
    );
    expect(contract.indexOf("for (const item of foldItems) {")).toBeLessThan(
      contract.indexOf("const withItems =")
    );
  }, 30_000);

  it("falsifier: without the declared foldReturn, the same pagination-shaped captures omit the drill endpoint (control)", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-gql-paginated-nofold-"));
    const runRoot = join(workDir, "run");
    writeRunDir(runRoot);

    const siteId = `gql-paginated-nofold-test-run${process.pid}`;
    siteOutDirWithout = join(REPO_ROOT, "src", "sites", siteId);
    writeFlowFile(siteOutDirWithout, { withFoldReturn: false });

    const result = run(runRoot, siteId);
    const out = `${result.stdout}\n${result.stderr}`;

    expect(result.status, out).toBe(0);

    const contract = readFileSync(join(siteOutDirWithout, "contract.ts"), "utf8");
    expect(contract).not.toContain("/listings/api/v1/detail");
    expect(contract).not.toContain("foldItems");
    // Pagination itself is unaffected by the absence of a foldReturn.
    expect(contract).toContain("itemsById");
  }, 30_000);

  it("emits a materially different contract with vs. without the declared foldReturn", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-gql-paginated-diff-"));
    const runRoot = join(workDir, "run");
    writeRunDir(runRoot);

    const siteIdWith = `gql-paginated-diff-with-run${process.pid}`;
    siteOutDirWith = join(REPO_ROOT, "src", "sites", siteIdWith);
    writeFlowFile(siteOutDirWith, { withFoldReturn: true });
    expect(run(runRoot, siteIdWith).status).toBe(0);
    const contractWith = readFileSync(join(siteOutDirWith, "contract.ts"), "utf8");

    const siteIdWithout = `gql-paginated-diff-without-run${process.pid}`;
    siteOutDirWithout = join(REPO_ROOT, "src", "sites", siteIdWithout);
    writeFlowFile(siteOutDirWithout, { withFoldReturn: false });
    expect(run(runRoot, siteIdWithout).status).toBe(0);
    const contractWithout = readFileSync(join(siteOutDirWithout, "contract.ts"), "utf8");

    expect(contractWith.replace(new RegExp(siteIdWith, "g"), "SITE")).not.toBe(
      contractWithout.replace(new RegExp(siteIdWithout, "g"), "SITE")
    );
  }, 30_000);
});
