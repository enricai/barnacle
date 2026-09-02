import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

/**
 * Reproduces the reported failure: `detectPaginationSignal` returned null
 * whenever the SELECTED primary capture happened to be a partial/last page
 * (its item count doesn't evenly divide the declared page size), even when
 * another 2xx capture of the SAME operation (same endpoint path + operation
 * name) in the run independently proves the operation paginates. Pagination
 * is a property of the operation, not of any single capture — see
 * `detectPaginationSignal` in recon-generate.ts.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const SEARCH_QUERY =
  "query listingSearch($pagination: PaginationInput) { listingSearch(pagination: $pagination) { total items { id title } } }";

function makeListingPage(count: number, offset: number): Record<string, unknown>[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `listing-${offset + i}`,
    title: `Listing ${offset + i}`,
  }));
}

/** The selected primary: a partial/last page — 4 items against a pageSize-10
 * variable, so `4 % 10 !== 0` fails the direct check. Padded with a large
 * unrelated field so the scoring heuristic in resolvePrimaryGraphQLOperation
 * (size-weighted among same-identity candidates) reliably picks THIS
 * capture, not the full-page sibling below, as the primary. */
function partialPageCapture(): unknown {
  return {
    timestamp: "2024-01-01T00:00:00Z",
    phase: "browse",
    method: "POST",
    url: "https://example.com/graphql",
    status: 200,
    requestHeaders: { "Content-Type": "application/json" },
    requestPostData: JSON.stringify({
      query: SEARCH_QUERY,
      variables: { pagination: { count: 10, skip: 20 } },
    }),
    responseHeaders: {},
    responseBody: {
      listingSearch: {
        total: 24,
        items: makeListingPage(4, 21),
        _paddingToOutweighSibling: "x".repeat(4000),
      },
    },
    operationName: "listingSearch",
    query: SEARCH_QUERY,
    variables: { pagination: { count: 10, skip: 20 } },
    decodedParams: null,
  };
}

/** A same-identity (same endpointPath + operationName, per
 * `operationGroupKey`) sibling capture from earlier in the run whose own
 * response/variables satisfy the `% pageSize` check unassisted — the real
 * cross-capture proof the fix must consult. */
function fullPageSiblingCapture(): unknown {
  return {
    timestamp: "2024-01-01T00:00:01Z",
    phase: "browse",
    method: "POST",
    url: "https://example.com/graphql",
    status: 200,
    requestHeaders: { "Content-Type": "application/json" },
    requestPostData: JSON.stringify({
      query: SEARCH_QUERY,
      variables: { pagination: { count: 10, skip: 0 } },
    }),
    responseHeaders: {},
    responseBody: { listingSearch: { total: 24, items: makeListingPage(10, 1) } },
    operationName: "listingSearch",
    query: SEARCH_QUERY,
    variables: { pagination: { count: 10, skip: 0 } },
    decodedParams: null,
  };
}

/** A DIFFERENT operation (different operationName) that also independently
 * satisfies the full-page check — must NOT be mistaken for evidence about
 * `listingSearch`. */
function differentOperationFullPageCapture(): unknown {
  const query =
    "query featuredListings($pagination: PaginationInput) { featuredListings(pagination: $pagination) { total items { id title } } }";
  return {
    timestamp: "2024-01-01T00:00:02Z",
    phase: "browse",
    method: "POST",
    url: "https://example.com/graphql",
    status: 200,
    requestHeaders: { "Content-Type": "application/json" },
    requestPostData: JSON.stringify({
      query,
      variables: { pagination: { count: 10, skip: 0 } },
    }),
    responseHeaders: {},
    responseBody: { featuredListings: { total: 24, items: makeListingPage(10, 1) } },
    operationName: "featuredListings",
    query,
    variables: { pagination: { count: 10, skip: 0 } },
    decodedParams: null,
  };
}

function writeRunDir(root: string, captures: unknown[]): void {
  mkdirSync(join(root, "graphql"), { recursive: true });
  mkdirSync(join(root, "replays"), { recursive: true });
  mkdirSync(join(root, "aux"), { recursive: true });
  captures.forEach((capture, i) => {
    writeFileSync(
      join(root, "graphql", `${String(i).padStart(3, "0")}-browse-search.json`),
      JSON.stringify(capture)
    );
  });
}

function writeFlowFile(siteOutDir: string): void {
  mkdirSync(siteOutDir, { recursive: true });
  const flow: Record<string, unknown> = {
    steps: [{ step: "search for listings" }],
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

describe("detectPaginationSignal cross-capture evidence — runtime e2e", () => {
  it("emits a paging loop when the selected primary is a partial page but a same-operation sibling proves pagination", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-pagination-cross-capture-"));
    const runRoot = join(workDir, "run");
    writeRunDir(runRoot, [
      fullPageSiblingCapture(),
      differentOperationFullPageCapture(),
      partialPageCapture(),
    ]);

    const siteId = `pagination-cross-capture-test-run${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    writeFlowFile(siteOutDir);

    const result = run(runRoot, siteId);
    const out = `${result.stdout}\n${result.stderr}`;
    expect(result.status, out).toBe(0);

    const contract = readFileSync(join(siteOutDir, "contract.ts"), "utf8");
    expect(contract).toContain("const PAGE_SIZE = 10;");
    expect(contract).toContain("itemsById");
    expect(contract).toContain("MAX_PAGES");
  }, 60_000);

  it("falsifier: stays a single-fixed-page contract when no same-operation sibling proves pagination (control)", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-pagination-cross-capture-nosibling-"));
    const runRoot = join(workDir, "run");
    // Only the different-operation full-page capture is present alongside the
    // partial-page primary — no evidence for the SAME operation, so no
    // signal should be manufactured.
    writeRunDir(runRoot, [differentOperationFullPageCapture(), partialPageCapture()]);

    const siteId = `pagination-cross-capture-nosibling-test-run${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    writeFlowFile(siteOutDir);

    const result = run(runRoot, siteId);
    const out = `${result.stdout}\n${result.stderr}`;
    expect(result.status, out).toBe(0);

    const contract = readFileSync(join(siteOutDir, "contract.ts"), "utf8");
    expect(contract).not.toContain("const PAGE_SIZE = 10;");
    expect(contract).not.toContain("MAX_PAGES");
  }, 60_000);
});
