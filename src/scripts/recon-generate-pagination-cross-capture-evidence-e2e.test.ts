import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

/**
 * Full-pipeline proof that pagination detection sources its signal from
 * cross-capture evidence: when the facet-bearing capture selected as
 * primary is itself a partial page (items % pageSize !== 0), but another
 * captured page of the SAME operation in the run independently satisfies
 * the full-page pagination check, the emitted contract.ts must still get
 * the bounded paging loop instead of silently downgrading to a single
 * fixed-page call.
 *
 * Combines recon-generate-primary-capture-facet-wiring-e2e.test.ts's
 * writeRunDir/gqlCapture/vocabulary/recon-flow.json recipe (to force the
 * partial-page facet-bearing capture to win primary selection via
 * facetScore) with recon-generate-graphql-paginated-fetch-loop.test.ts's
 * pagination-loop assertions (PAGE_SIZE/skip/MAX_PAGES/itemsById markers).
 * Exercises the real CLI, matching this repo's convention that pagination
 * detection is only tested via the CLI since detectPaginationSignal is
 * unexported inside recon-generate.ts's un-exported main.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

function gqlCapture(overrides: {
  phase: string;
  operationName: string | null;
  query: string | null;
  variables: Record<string, unknown> | null;
  responseBody: unknown;
}) {
  return {
    timestamp: "2026-08-20T10:23:03.000Z",
    phase: overrides.phase,
    method: "POST",
    url: "https://www.catalog-fixture.example.com/graphql",
    status: 200,
    requestHeaders: { "Content-Type": "application/json" },
    requestPostData: JSON.stringify({ variables: overrides.variables }),
    responseHeaders: { "content-type": "application/json" },
    responseBody: overrides.responseBody,
    operationName: overrides.operationName,
    query: overrides.query,
    variables: overrides.variables,
    decodedParams: null,
  };
}

/** 10 catalog item objects, each with a bare `id` identity field. */
function makeCatalogPage(count: number): Record<string, unknown>[] {
  return Array.from({ length: count }, (_, i) => ({ id: `sku-${i}`, name: `Item ${i}` }));
}

/**
 * The run dir: an unfiltered full-page capture (10 items, total:437 —
 * satisfies the pagination check on its own) plus a facet-bearing partial
 * page capture (4 items, total:4 — fails the `% pageSize` check on its
 * own, but wins primary selection via facetScore).
 */
function writeRunDir(root: string): void {
  mkdirSync(join(root, "graphql"), { recursive: true });
  mkdirSync(join(root, "replays"), { recursive: true });
  mkdirSync(join(root, "aux"), { recursive: true });
  writeFileSync(join(root, "replays", "rate-limit.json"), JSON.stringify([]));

  const query =
    "query search_Items($pagination: PaginationInput, $filters: String) { search(pagination: $pagination, filters: $filters) { total items { id name } } }";

  const unfilteredFullPage = gqlCapture({
    phase: "browse",
    operationName: "search_Items",
    query,
    variables: { pagination: { count: 10, skip: 0 } },
    responseBody: { search: { total: 437, items: makeCatalogPage(10) } },
  });

  const facetBearingPartialPage = gqlCapture({
    phase: "filter",
    operationName: "search_Items",
    query,
    variables: {
      pagination: { count: 10, skip: 0 },
      filters: "category:kitchen|priceRange:10~50",
    },
    responseBody: { search: { total: 4, items: makeCatalogPage(4) } },
  });

  writeFileSync(
    join(root, "graphql", "000-browse-action.json"),
    JSON.stringify(unfilteredFullPage)
  );
  writeFileSync(
    join(root, "graphql", "001-filter-action.json"),
    JSON.stringify(facetBearingPartialPage)
  );
}

function writeVocabularyModule(dir: string): string {
  const vocabPath = join(dir, "vocabulary.mjs");
  writeFileSync(
    vocabPath,
    `export const vocabulary = {
  subject: /(?!)/,
  exclusions: [],
  table: [
    [/category/i, "Category"],
    [/price ?range/i, "PriceRange"],
  ],
};
`
  );
  return vocabPath;
}

let workDir: string | null = null;
let siteOutDir: string | null = null;

afterEach(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
  if (siteOutDir) rmSync(siteOutDir, { recursive: true, force: true });
  workDir = null;
  siteOutDir = null;
});

describe("recon-generate CLI — pagination signal survives a partial-page primary via cross-capture evidence", () => {
  it("emits the bounded paging loop when the primary capture is a partial page but a sibling capture proves the operation paginates", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-pagination-cross-capture-evidence-e2e-"));
    const runRoot = join(workDir, "run");
    writeRunDir(runRoot);

    const siteId = `pagination-cross-capture-evidence-e2e-test-${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    mkdirSync(siteOutDir, { recursive: true });
    expect(existsSync(join(siteOutDir, "contract.ts"))).toBe(false);

    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({
        steps: [
          { step: "Fill in the Category field with 'kitchen'" },
          { step: "Fill in the PriceRange field with '10~50'" },
        ],
      })
    );

    const vocabularyPath = writeVocabularyModule(workDir);

    const result = spawnSync(
      TSX_BIN,
      [
        GENERATE_SCRIPT,
        "--site-id",
        siteId,
        "--run-dir",
        runRoot,
        "--emit",
        "ts",
        "--force",
        "--vocabulary",
        vocabularyPath,
      ],
      { cwd: REPO_ROOT, encoding: "utf8" }
    );

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);

    const contract = readFileSync(join(siteOutDir, "contract.ts"), "utf8");

    // The partial-page facet-bearing capture (4 items) was selected as
    // primary — proven by the facet splice reaching the emitted call site,
    // exactly as recon-generate-primary-capture-facet-wiring-e2e.test.ts
    // proves for the non-paginating case.
    expect(contract).toContain("payload.Category");
    expect(contract).toContain(
      "filters: `category:$" + "{payload.Category}|priceRange:$" + "{payload.PriceRange}`"
    );

    // Despite the primary sample being a partial page (4 % 10 !== 0, so it
    // fails the pagination check on its own), the bounded paging loop is
    // still emitted because the sibling full-page capture (10 items,
    // total:437) independently proves the operation paginates.
    expect(contract).toContain("const PAGE_SIZE = 10;");
    expect(contract).toContain("skip += PAGE_SIZE;");
    expect(contract).toContain("const MAX_PAGES = payload.maxPages ?? 50;");
    expect(contract).toContain("itemsById.set(String(item.id), item);");
  }, 60_000);
});
