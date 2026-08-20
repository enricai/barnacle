import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

/**
 * Full-pipeline proof that the primary-selection fix actually reaches the
 * emitted, callable code: a run dir shaped like the bug report — several
 * `catalogSearch_Items` captures that share one operationName, most of them
 * unfiltered and recurring with a large response body, plus a single
 * facet-bearing capture whose `filters` string packs a declared payload
 * field — must, through the real CLI, both select the facet-bearing capture
 * as primary AND splice the caller's payload into the emitted filters
 * template literal. Distinct from the selectPrimaryGraphQLOperation unit
 * test: selection could be fixed while renderGqlVariablesExpr/
 * spliceFacetsIntoStringVariable emission stays broken, or vice versa — only
 * an end-to-end run over the generated contract.ts source proves both links
 * of the chain.
 *
 * Mirrors recon-generate-graphql-readonly-e2e.test.ts's writeRunDir/gqlCapture
 * pattern and recon-generate-gql-unused-payload-guard.test.ts's regex-based
 * executeHttp body assertions.
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

/** A large, recurring catalog page — the pre-fix winner on size/recurrence alone. */
function makeUnfilteredCatalogPage(): Record<string, unknown>[] {
  return Array.from({ length: 100 }, (_, i) => ({ id: `sku-${i}`, name: `Item ${i}` }));
}

/**
 * The run dir: three unfiltered `catalogSearch_Items` captures (large body,
 * high recurrence, as in the bug report) plus one facet-bearing capture
 * whose `filters` string packs a `category` facet the flow declares as a
 * payload field.
 */
function writeRunDir(root: string): void {
  mkdirSync(join(root, "graphql"), { recursive: true });
  mkdirSync(join(root, "replays"), { recursive: true });
  mkdirSync(join(root, "aux"), { recursive: true });
  writeFileSync(join(root, "replays", "rate-limit.json"), JSON.stringify([]));

  const query =
    "query catalogSearch_Items($filters: String) { catalogSearch(filters: $filters) { items { id name } } }";

  // Incidentally mentions both facet field names ("category" in sort.by,
  // "priceRange" in note) so fieldScore's substring match alone cannot
  // distinguish this decoy from the facet-bearing capture below — only the
  // facet-splice-based score can, matching the decoy shape
  // recon-generate-primary-capture-facet-preference.test.ts uses to prove
  // the same thing at the unit level.
  const unfiltered = () =>
    gqlCapture({
      phase: "browse-the-catalog",
      operationName: "catalogSearch_Items",
      query,
      variables: { pagination: { count: 24 }, sort: { by: "category" }, note: "priceRange" },
      responseBody: { catalogSearch: { items: makeUnfilteredCatalogPage() } },
    });

  const facetBearing = gqlCapture({
    phase: "filter-the-catalog",
    operationName: "catalogSearch_Items",
    query,
    variables: { filters: "category:kitchen|priceRange:10~50" },
    responseBody: { catalogSearch: { items: [{ id: "sku-1", name: "Item 1" }] } },
  });

  writeFileSync(
    join(root, "graphql", "000-browse-the-catalog-action.json"),
    JSON.stringify(unfiltered())
  );
  writeFileSync(
    join(root, "graphql", "001-browse-the-catalog-action.json"),
    JSON.stringify(unfiltered())
  );
  writeFileSync(
    join(root, "graphql", "002-browse-the-catalog-action.json"),
    JSON.stringify(unfiltered())
  );
  writeFileSync(
    join(root, "graphql", "003-filter-the-catalog-action.json"),
    JSON.stringify(facetBearing)
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

describe("recon-generate CLI — primary GraphQL selection reaches the emitted call site", () => {
  it("splices the caller's payload into the filter facet string when a facet-bearing capture is primary", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-primary-capture-facet-wiring-e2e-"));
    const runRoot = join(workDir, "run");
    writeRunDir(runRoot);

    const siteId = `primary-capture-facet-wiring-e2e-test-${process.pid}`;
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

    const executeHttpMatch = contract.match(/async executeHttp\([\s\S]*?\n {2}},\n/);
    expect(executeHttpMatch, contract).not.toBeNull();
    const executeHttpBody = executeHttpMatch?.[0] ?? "";

    // The caller's payload actually reaches the outgoing request: the
    // facet-bearing capture was selected as primary, and its filters string
    // was spliced with a payload reference rather than emitted as a frozen
    // literal on an unused param.
    expect(executeHttpBody).toContain("payload.Category");
    expect(executeHttpBody).toContain(
      "filters: `category:$" + "{payload.Category}|priceRange:$" + "{payload.PriceRange}`"
    );
    expect(executeHttpBody).not.toContain("_payload:");
    expect(executeHttpBody).toContain("async executeHttp(\n    payload:");
  }, 30_000);
});
