import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

/**
 * Regression guard for the cross-capture pagination fix
 * (`recon-generate-pagination-cross-capture-signal.test.ts`): a run whose
 * ONLY capture is a genuinely-final partial page (`total === items.length`)
 * of a `count`+`skip`+`total`-shaped operation, with NO other capture of any
 * kind in the run, must still emit the single fixed-page call. The fix must
 * require real corroborating evidence from a same-identity sibling — it must
 * not incidentally relax the guard so that a bare container shape alone
 * fabricates a paging loop.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const SEARCH_QUERY =
  "query listingSearch_Items($pagination: PaginationInput, $filters: String) { search_Items(pagination: $pagination, filters: $filters) { total items { id title } } }";

function makeItemPage(count: number): Record<string, unknown>[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `item-${i}`,
    title: `Item ${i}`,
  }));
}

/** The single capture in the run: a partial page (4 items against a
 * pageSize-10 variable) that is genuinely the last page — `total` equals the
 * item count, so there is no more data to fetch, and no other capture exists
 * to prove the operation paginates elsewhere. */
function writeSingleCapturePartialPageRunDir(root: string): void {
  mkdirSync(join(root, "graphql"), { recursive: true });
  mkdirSync(join(root, "replays"), { recursive: true });
  mkdirSync(join(root, "aux"), { recursive: true });

  const searchItems = {
    timestamp: "2026-08-18T10:23:03.000Z",
    phase: "browse-the-items",
    method: "POST",
    url: "https://www.items-fixture.example.com/items/graph",
    status: 200,
    requestHeaders: { "Content-Type": "application/json" },
    requestPostData: "{}",
    responseHeaders: {},
    responseBody: { search_Items: { total: 4, items: makeItemPage(4) } },
    operationName: "listingSearch_Items",
    query: SEARCH_QUERY,
    variables: { pagination: { count: 10, skip: 0 }, filters: "category:widgets|color:blue" },
    decodedParams: null,
  };

  writeFileSync(
    join(root, "graphql", "000-browse-the-items-action.json"),
    JSON.stringify(searchItems)
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

describe("recon-generate pagination signal: partial-page primary with no sibling anywhere in the run", () => {
  it("still emits a single fixed-page call, not a fabricated paging loop", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-pagination-no-sibling-"));
    const runRoot = join(workDir, "run");
    writeSingleCapturePartialPageRunDir(runRoot);

    const siteId = `pagination-no-sibling-test-${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    expect(existsSync(siteOutDir)).toBe(false);

    const result = spawnSync(
      TSX_BIN,
      [GENERATE_SCRIPT, "--site-id", siteId, "--run-dir", runRoot, "--emit", "ts"],
      { cwd: REPO_ROOT, encoding: "utf8" }
    );

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);

    const contract = readFileSync(join(siteOutDir, "contract.ts"), "utf8");

    expect(contract).toMatch(
      /const data = await getGql\(context\.baseUrl\)\("listingSearch_Items", \w+_QUERY, \{ pagination: \{"count":10,"skip":0\}, filters: "category:widgets\|color:blue" \}\);\n\s*return \{ data \};/
    );
    expect(contract).not.toContain("MAX_PAGES");
    expect(contract).not.toContain("maxPages");
    expect(contract).not.toContain("itemsById");
  }, 30_000);
});
