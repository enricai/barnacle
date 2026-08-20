import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

/**
 * Acceptance test for the read-only GraphQL selection path:
 * reproduces a listings-fixture-shaped capture set (a read-only flow with no
 * submitStep/mutation captures) through the real CLI entrypoint and asserts the emitted
 * contract.ts's hot path targets the primary data operation, not the chronologically-first
 * page-load query. Covers required outcomes 1 (selection) and 2 (coherent call-site
 * emission) end to end through readJsonDir -> selection -> emission; outcome 3 (mutation
 * path unchanged) belongs to a separate subtask.
 *
 * Exercises the real CLI (`tsx recon-generate.ts`), matching
 * recon-generate-empty-capture-guard.test.ts, since the read-only selection gate lives
 * inside the un-exported `main`.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

function gqlCapture(overrides: {
  phase: string;
  url: string;
  operationName: string | null;
  query: string | null;
  variables: Record<string, unknown> | null;
  responseLength: number;
  requestPostData?: string;
}) {
  return {
    timestamp: "2026-08-18T10:23:03.000Z",
    phase: overrides.phase,
    method: "POST",
    url: overrides.url,
    status: 200,
    requestHeaders: { "Content-Type": "application/json" },
    requestPostData: overrides.requestPostData ?? "{}",
    responseHeaders: {},
    responseBody: { pad: "x".repeat(Math.max(0, overrides.responseLength - '{"pad":""}'.length)) },
    operationName: overrides.operationName,
    query: overrides.query,
    variables: overrides.variables,
    decodedParams: null,
  };
}

function gqlCaptureWithBody(overrides: {
  phase: string;
  url: string;
  operationName: string | null;
  query: string | null;
  variables: Record<string, unknown> | null;
  responseBody: unknown;
}) {
  return {
    timestamp: "2026-08-18T10:23:03.000Z",
    phase: overrides.phase,
    method: "POST",
    url: overrides.url,
    status: 200,
    requestHeaders: { "Content-Type": "application/json" },
    requestPostData: "{}",
    responseHeaders: {},
    responseBody: overrides.responseBody,
    operationName: overrides.operationName,
    query: overrides.query,
    variables: overrides.variables,
    decodedParams: null,
  };
}

/** 10 catalog-style item objects, each with a bare `id` identity field. */
function makeCatalogPage(count: number): Record<string, unknown>[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `sku-${i}`,
    name: `Item ${i}`,
  }));
}

/**
 * A run dir shaped like the reported incoherent-selection bug: a flow that
 * declares `submitStep:true` (e.g. "apply the filter") but whose captures
 * contain zero mutations -- a filtered search sent as a GraphQL query, not a
 * mutation. Six facet-bearing anonymous captures and one named-but-unfiltered
 * capture live on the site's own backend host; sixteen GraphQL-shaped POSTs
 * sharing the SAME operationName live on a third-party host and sort ahead of
 * the own-backend captures, so the ungated firstGraphQLQuery()/
 * firstEndpointPath() fallback -- were it still reachable -- would pick one of
 * them purely because it comes first in capture order.
 */
function writeSubmitStepMutationFreeRunDir(root: string): void {
  mkdirSync(join(root, "graphql"), { recursive: true });
  mkdirSync(join(root, "replays"), { recursive: true });
  mkdirSync(join(root, "aux"), { recursive: true });

  const thirdPartyQuery = gqlCapture({
    phase: "open-the-metro-filter",
    url: "https://gql.third-party-tracker.example.net/collect/graph",
    operationName: "listingSearch_Listings",
    query: "query listingSearch_Listings { trackedEvents { id } }",
    variables: null,
    responseLength: 2048,
  });
  for (let i = 0; i < 16; i++) {
    writeFileSync(
      join(root, "graphql", `000-open-the-metro-filter-tracker-${String(i).padStart(2, "0")}.json`),
      JSON.stringify(thirdPartyQuery)
    );
  }

  const facetQuery = (metro: string) =>
    gqlCapture({
      phase: "open-the-metro-filter",
      url: "https://www.own-backend-fixture.example.com/x/graph",
      operationName: null,
      query: "query listingSearch_Listings($metro: String) { listings(metro: $metro) { id name } }",
      variables: { metro },
      responseLength: 61440,
    });
  const metros = ["AUSTIN", "DENVER", "SEATTLE", "BOSTON", "MIAMI", "PHOENIX"];
  metros.forEach((metro, i) => {
    writeFileSync(
      join(root, "graphql", `100-open-the-metro-filter-facet-${i}.json`),
      JSON.stringify(facetQuery(metro))
    );
  });

  const unfilteredNamedQuery = gqlCapture({
    phase: "open-the-metro-filter",
    url: "https://www.own-backend-fixture.example.com/x/graph",
    operationName: "listingSearch_Listings",
    query: "query listingSearch_Listings($metro: String) { listings(metro: $metro) { id name } }",
    variables: { metro: null },
    responseLength: 61440,
  });
  writeFileSync(
    join(root, "graphql", "101-open-the-metro-filter-unfiltered.json"),
    JSON.stringify(unfilteredNamedQuery)
  );
}

/** A run dir whose primary operation's response exposes a total alongside a
 * skip+count pagination variable — the paging signal. */
function writePagedRunDir(root: string): void {
  mkdirSync(join(root, "graphql"), { recursive: true });
  mkdirSync(join(root, "replays"), { recursive: true });
  mkdirSync(join(root, "aux"), { recursive: true });

  const catalogSearch = gqlCaptureWithBody({
    phase: "browse-the-catalog",
    url: "https://www.catalog-fixture.example.com/catalog/graph",
    operationName: "catalogSearch_Items",
    query:
      "query catalogSearch_Items($pagination: PaginationInput) { search(pagination: $pagination) { total items { id name } } }",
    variables: { pagination: { count: 10, skip: 0 }, sort: "PRICE" },
    responseBody: { search: { total: 20, items: makeCatalogPage(10) } },
  });

  writeFileSync(
    join(root, "graphql", "000-browse-the-catalog-action.json"),
    JSON.stringify(catalogSearch)
  );
}

/** The capture set: listings-fixture, POST /graph and POST /listings/graph. */
function writeRunDir(root: string): void {
  mkdirSync(join(root, "graphql"), { recursive: true });
  mkdirSync(join(root, "replays"), { recursive: true });
  mkdirSync(join(root, "aux"), { recursive: true });

  const listingSearch = (requestPostData: string) =>
    gqlCapture({
      phase: "open-the-metro-filter",
      url: "https://www.listings-fixture.example.com/listings/graph",
      operationName: "listingSearch_Listings",
      query: "query listingSearch_Listings($metro: String) { listings(metro: $metro) { id name } }",
      variables: { metro: "AUSTIN" },
      responseLength: 565648,
      requestPostData,
    });
  const anonListingQuery = gqlCapture({
    phase: "open-the-metro-filter",
    url: "https://www.listings-fixture.example.com/listings/graph",
    operationName: null,
    query: "query { listingFacets { id } }",
    variables: null,
    responseLength: 59891,
  });
  const bestPromotionForMarket = gqlCapture({
    phase: "home",
    url: "https://www.listings-fixture.example.com/graph",
    operationName: "bestPromotionForMarket",
    query: "query bestPromotionForMarket { promotion { id imageUrl } }",
    variables: null,
    responseLength: 1099,
  });
  const targetedOffers = gqlCapture({
    phase: "home",
    url: "https://www.listings-fixture.example.com/graph",
    operationName: "targetedOffers",
    query: "query targetedOffers { offers { id } }",
    variables: null,
    responseLength: 291,
  });

  writeFileSync(
    join(root, "graphql", "000-home-action.json"),
    JSON.stringify(bestPromotionForMarket)
  );
  writeFileSync(join(root, "graphql", "001-home-action.json"), JSON.stringify(targetedOffers));
  writeFileSync(
    join(root, "graphql", "002-open-the-metro-filter-action.json"),
    JSON.stringify(listingSearch('{"metro":"AUSTIN"}'))
  );
  writeFileSync(
    join(root, "graphql", "003-open-the-metro-filter-action.json"),
    JSON.stringify(anonListingQuery)
  );
  // The re-query: same operation, different request body, firing again on filter re-apply.
  writeFileSync(
    join(root, "graphql", "004-open-the-metro-filter-action.json"),
    JSON.stringify(listingSearch('{"metro":"DENVER"}'))
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

describe("recon-generate read-only GraphQL flow: listings-fixture-shaped capture set", () => {
  it("selects listingSearch_Listings over the chronologically-first, near-unrelated bestPromotionForMarket, with a coherent call site", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-graphql-readonly-e2e-"));
    const runRoot = join(workDir, "run");
    writeRunDir(runRoot);

    const siteId = `graphql-readonly-e2e-test-${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    expect(existsSync(siteOutDir)).toBe(false);

    const result = spawnSync(
      TSX_BIN,
      [GENERATE_SCRIPT, "--site-id", siteId, "--run-dir", runRoot, "--emit", "ts"],
      { cwd: REPO_ROOT, encoding: "utf8" }
    );

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);

    const contract = readFileSync(join(siteOutDir, "contract.ts"), "utf8");

    // Outcome 1: the primary data operation's query text and endpoint were selected,
    // not the chronologically-first page-load query.
    expect(contract).toContain("listingSearch_Listings");
    expect(contract).toContain("/listings/graph");
    expect(contract).not.toContain("bestPromotionForMarket");

    // Outcome 2: the emitted getGql() call site's operationName is derived from the
    // selected capture, not a siteId-derived "...Search" literal.
    expect(contract).toContain('"listingSearch_Listings"');
    expect(contract).not.toMatch(/getGql\([^)]*\)\("[A-Za-z]*Search"/);

    // No paging signal in this capture set (no total/count field alongside a
    // pagination variable) — the existing single fixed-page call form is
    // still emitted, unchanged.
    expect(contract).toMatch(
      /const data = await getGql\(context\.baseUrl\)\("listingSearch_Listings", \w+_QUERY, \{ metro: "AUSTIN" \}\);\n\s*return \{ data \};/
    );
    expect(contract).not.toContain("MAX_PAGES");
    expect(contract).not.toContain("itemsById");
  }, 30_000);
});

describe("recon-generate read-only GraphQL flow: catalog-fixture capture set with a paging signal", () => {
  it("emits a bounded paging loop that advances skip and merges pages by identity", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-graphql-readonly-paging-e2e-"));
    const runRoot = join(workDir, "run");
    writePagedRunDir(runRoot);

    const siteId = `graphql-readonly-paging-e2e-test-${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    expect(existsSync(siteOutDir)).toBe(false);

    const result = spawnSync(
      TSX_BIN,
      [GENERATE_SCRIPT, "--site-id", siteId, "--run-dir", runRoot, "--emit", "ts"],
      { cwd: REPO_ROOT, encoding: "utf8" }
    );

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);

    const contract = readFileSync(join(siteOutDir, "contract.ts"), "utf8");

    // (a) The loop advances the pagination variable by the observed page size.
    expect(contract).toContain("const PAGE_SIZE = 10;");
    expect(contract).toContain("skip += PAGE_SIZE;");
    expect(contract).toContain(
      "pagination: { ...baseVariables.pagination, count: PAGE_SIZE, skip: skip }"
    );

    // (b) It stops at the reported total or a finite maxPages cap — never an
    // unbounded while(true).
    expect(contract).toContain("const MAX_PAGES = 50;");
    expect(contract).toContain("total = page.search.total;");
    expect(contract).not.toMatch(/while\s*\(\s*true\s*\)/);

    // (c) Pages are merged by an identity field, not concatenated blindly.
    expect(contract).toContain("itemsById.set(String(item.id), item);");
    expect(contract).toContain("[...itemsById.values()]");
    expect(contract).not.toMatch(/\.push\(\.\.\.(page|data)\.search\.items\)/);
  }, 30_000);
});

describe("recon-generate: flow declares submitStep:true but captures zero mutations", () => {
  it("still runs host-gated/facet-aware primary GraphQL selection instead of falling through to the ungated first-capture fallback", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-graphql-submitstep-no-mutation-e2e-"));
    const runRoot = join(workDir, "run");
    writeSubmitStepMutationFreeRunDir(runRoot);

    const siteId = `graphql-submitstep-no-mutation-e2e-test-${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    expect(existsSync(siteOutDir)).toBe(false);
    mkdirSync(siteOutDir, { recursive: true });
    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({
        steps: [{ step: "apply the metro filter", payloadField: "metro", submitStep: true }],
        ownBackendHostnames: ["www.own-backend-fixture.example.com"],
      })
    );

    const result = spawnSync(
      TSX_BIN,
      [GENERATE_SCRIPT, "--site-id", siteId, "--run-dir", runRoot, "--emit", "ts", "--force"],
      { cwd: REPO_ROOT, encoding: "utf8" }
    );

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);

    const contract = readFileSync(join(siteOutDir, "contract.ts"), "utf8");

    // The emitted endpoint and query text come from the own-backend
    // capture's own operation, never the chronologically-first third-party
    // capture sharing the same operationName -- submitStep:true no longer
    // disables selection merely because no mutation was ever actually
    // captured. (defaultBaseUrl is derived elsewhere, out of this
    // subtask's scope, so it is not asserted on here.)
    expect(contract).toMatch(/endpoint: .*\/x\/graph/);
    expect(contract).toContain("listings(metro: $metro)");
    expect(contract).not.toContain("trackedEvents");
  }, 30_000);
});
