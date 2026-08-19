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
  }, 30_000);
});
