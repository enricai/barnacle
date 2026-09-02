import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

/**
 * Guards the operation-scoping of the cross-capture pagination fix: a
 * full-page capture belonging to a DIFFERENT GraphQL operation must not be
 * treated as evidence that the selected primary's own (unrelated) operation
 * paginates. Cross-capture evidence must be scoped by the same operation
 * identity, mirroring the operationGroupKey scoping already used for
 * fold-plan primary matching (recon-generate.ts:8143).
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const SEARCH_QUERY =
  "query search_Items($pagination: PaginationInput, $filters: ItemFiltersInput) { search_Items(pagination: $pagination, filters: $filters) { total items { id title } } }";

const WIDGETS_QUERY =
  "query otherOp_Widgets($pagination: PaginationInput) { otherOp_Widgets(pagination: $pagination) { total items { id title } } }";

function makeItemsPage(count: number, offset: number): Record<string, unknown>[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `item-${offset + i}`,
    title: `Item ${offset + i}`,
  }));
}

/** The selected primary: a partial-page capture of `search_Items` — 4 items
 * matching total:4, so no full-page evidence for this operation exists
 * anywhere in the run. Padded with a large unrelated field so the
 * size-weighted scoring heuristic in selectPrimaryGraphQLOperation reliably
 * picks THIS capture, not the other operation's larger full page, as the
 * primary. */
function searchItemsPartialCapture(): unknown {
  return {
    timestamp: "2024-01-01T00:00:00Z",
    phase: "browse",
    method: "POST",
    url: "https://example.com/graphql/search",
    status: 200,
    requestHeaders: { "Content-Type": "application/json" },
    requestPostData: JSON.stringify({
      query: SEARCH_QUERY,
      variables: { pagination: { count: 10, skip: 0 }, filters: { category: "widgets" } },
    }),
    responseHeaders: {},
    responseBody: {
      search_Items: {
        total: 4,
        items: makeItemsPage(4, 1),
        _paddingToOutweighOtherOperation: "x".repeat(4000),
      },
    },
    operationName: "search_Items",
    query: SEARCH_QUERY,
    variables: { pagination: { count: 10, skip: 0 }, filters: { category: "widgets" } },
    decodedParams: null,
  };
}

/** A DIFFERENT operation's full-page capture that independently satisfies
 * the full-page check — must NOT leak a pagination signal onto
 * `search_Items`, which has no full-page sibling of its own. */
function otherOpWidgetsFullPageCapture(): unknown {
  return {
    timestamp: "2024-01-01T00:00:01Z",
    phase: "browse",
    method: "POST",
    url: "https://example.com/graphql/widgets",
    status: 200,
    requestHeaders: { "Content-Type": "application/json" },
    requestPostData: JSON.stringify({
      query: WIDGETS_QUERY,
      variables: { pagination: { count: 10, skip: 0 } },
    }),
    responseHeaders: {},
    responseBody: {
      otherOp_Widgets: {
        total: 200,
        items: makeItemsPage(10, 1),
      },
    },
    operationName: "otherOp_Widgets",
    query: WIDGETS_QUERY,
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
    steps: [{ step: "search for items" }],
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

describe("detectPaginationSignal cross-capture evidence — operation scope guard e2e", () => {
  it("does not grant a paging loop when the only full-page capture in the run belongs to a different operation", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-pagination-cross-capture-scope-guard-"));
    const runRoot = join(workDir, "run");
    writeRunDir(runRoot, [otherOpWidgetsFullPageCapture(), searchItemsPartialCapture()]);

    const siteId = `pagination-cross-capture-scope-guard-test-run${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    writeFlowFile(siteOutDir);

    const result = run(runRoot, siteId);
    const out = `${result.stdout}\n${result.stderr}`;
    expect(result.status, out).toBe(0);

    const contract = readFileSync(join(siteOutDir, "contract.ts"), "utf8");
    expect(contract).toContain("search_Items");
    expect(contract).not.toContain("MAX_PAGES");
    expect(contract).not.toContain("itemsById");
  }, 60_000);
});
