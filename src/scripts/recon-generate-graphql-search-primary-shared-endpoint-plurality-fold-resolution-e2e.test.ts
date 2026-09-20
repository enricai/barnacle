import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

/**
 * Full-pipeline regression through the real `recon-generate` CLI: a schema-
 * stitched GraphQL gateway multiplexes dozens of distinct one-off operations
 * across a SINGLE shared endpoint, alongside one legitimately-repeated
 * search primary. The primary's own operationName group is the largest
 * group at the endpoint (a plurality) but never an absolute majority of
 * total same-endpoint traffic, since it's outnumbered in aggregate by the
 * many single/double-occurrence operations combined. Before the plurality
 * fix, `hasStableOperationIdentity` required a strict majority and could
 * never grant the rescue to a primary sharing an endpoint with this many
 * distinct operations, so the repeated primary fell through to the
 * freely-varying-response noise check and was dropped from the fold
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

const OTHER_OPERATION_NAMES = [
  "getNavCategories",
  "getPromoBanner",
  "getUserPrefs",
  "getStoreLocator",
  "getShippingEstimate",
  "getLoyaltyStatus",
  "getRecentlyViewed",
  "getWishlist",
  "getCartSummary",
  "getFeatureFlags",
  "getSiteConfig",
  "getFooterLinks",
  "getHeaderNav",
  "getSeasonalBanner",
  "getReviewsWidget",
  "getRelatedItems",
  "getInventoryAlert",
  "getPricingRules",
  "getTaxEstimate",
  "getCurrencyRates",
  "getLocaleSettings",
  "getAccountSummary",
  "getNotificationCount",
  "getSearchSuggestions",
  "getBrandList",
];

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

/** A single/double-occurrence one-off operation sharing the same GraphQL endpoint as the primary. */
function otherOperationCapture(operationName: string, occurrence: number, index: number): unknown {
  const query = `query ${operationName} { ${operationName} { id } }`;
  return {
    timestamp: `2024-01-01T00:01:${String(index).padStart(2, "0")}Z`,
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

function writeRunDir(root: string): void {
  mkdirSync(join(root, "graphql"), { recursive: true });
  mkdirSync(join(root, "replays"), { recursive: true });
  mkdirSync(join(root, "aux"), { recursive: true });
  writeFileSync(join(root, "replays", "rate-limit.json"), JSON.stringify([]));

  const searchCaptures = Array.from({ length: SEARCH_CALL_COUNT }, (_, i) =>
    graphqlSearchCapture(i)
  );
  // Each other operation occurs once or twice, so no single group ever
  // reaches the primary's 19-occurrence count, but their combined total
  // (25 operations x ~1.5 avg occurrences) outnumbers the primary in
  // aggregate same-endpoint traffic — the exact plurality-not-majority
  // shape bugfix-001 targets.
  const otherCaptures = OTHER_OPERATION_NAMES.flatMap((name, opIndex) =>
    Array.from({ length: (opIndex % 2) + 1 }, (_, occurrence) =>
      otherOperationCapture(name, occurrence, opIndex)
    )
  );

  // Interleave so the primary's occurrences aren't artificially clustered.
  const interleaved: unknown[] = [];
  let searchCursor = 0;
  let otherCursor = 0;
  while (searchCursor < searchCaptures.length || otherCursor < otherCaptures.length) {
    if (searchCursor < searchCaptures.length) interleaved.push(searchCaptures[searchCursor++]);
    if (otherCursor < otherCaptures.length) interleaved.push(otherCaptures[otherCursor++]);
    if (otherCursor < otherCaptures.length) interleaved.push(otherCaptures[otherCursor++]);
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

describe("recon-generate CLI: a search primary sharing a GraphQL endpoint with many distinct one-off operations resolves the fold plan", () => {
  it("resolves the fold plan and never warns 'no fold plan resolved' when the primary is a plurality but not a majority of same-endpoint traffic", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-shared-endpoint-gql-primary-"));
    const runRoot = join(workDir, "run");
    writeRunDir(runRoot);

    const siteId = `shared-endpoint-gql-primary-test-${process.pid}`;
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
