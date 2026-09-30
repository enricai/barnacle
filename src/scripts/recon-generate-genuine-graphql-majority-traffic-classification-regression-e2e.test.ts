import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

/**
 * `isGraphQL()`'s majority threshold was relaxed from a strict majority
 * (`parsedCount * 2 > votingPool.length`) to half-or-more (`>=`) so the
 * single-primary + single-GET-drill-down shape every foldReturn flow
 * produces still resolves to GraphQL. This pins the exact-half boundary
 * that relaxation exists for: genuinely-parsed GraphQL documents split
 * evenly against query-bearing own-backend captures that never parse as a
 * GraphQL operation (a REST endpoint whose request body happens to use a
 * `query` field name) must still classify as GraphQL, even though the
 * pre-fix strict-majority formula would have voted REST at that exact
 * split.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const OWN_BACKEND_HOST = "www.own-backend-majority-traffic-fixture.example.com";

function genuineGraphQLCapture(index: number) {
  const operationName = "searchListings";
  const query =
    "query searchListings($filter: String) { searchListings(filter: $filter) { id name } }";
  return {
    timestamp: "2026-08-18T10:23:03.000Z",
    phase: "search-listings",
    method: "POST",
    url: `https://${OWN_BACKEND_HOST}/graphql`,
    status: 200,
    requestHeaders: { "Content-Type": "application/json" },
    requestPostData: JSON.stringify({
      operationName,
      query,
      variables: { filter: `page-${index}` },
    }),
    responseHeaders: {},
    responseBody: { searchListings: [{ id: `L${index}`, name: "Unit A" }] },
    operationName,
    query,
    variables: { filter: `page-${index}` },
    decodedParams: null,
  };
}

/** A REST endpoint whose request body coincidentally uses a `query` field
 * name (e.g. a search-box passthrough) -- truthy `.query`, so it enters
 * the voting pool under both the pre-fix and post-fix formulas, but its
 * text never parses as a GraphQL operation document, so it's an anti-vote
 * either way. */
function coincidentalQueryFieldRestCapture(index: number) {
  return {
    timestamp: "2026-08-18T10:23:04.000Z",
    phase: "search-listings",
    method: "POST",
    url: `https://${OWN_BACKEND_HOST}/api/search`,
    status: 200,
    requestHeaders: { "Content-Type": "application/json" },
    requestPostData: JSON.stringify({ query: `unit ${index}` }),
    responseHeaders: {},
    responseBody: { results: [] },
    operationName: null,
    query: `unit ${index}`,
    variables: null,
    decodedParams: null,
  };
}

function runGenerate(
  runRoot: string,
  siteId: string,
  siteOutDir: string
): { stdout: string; status: number | null } {
  mkdirSync(siteOutDir, { recursive: true });
  writeFileSync(
    join(siteOutDir, "recon-flow.json"),
    JSON.stringify({
      steps: [{ step: "search listings" }],
      ownBackendHostnames: [OWN_BACKEND_HOST],
    })
  );
  const result = spawnSync(
    TSX_BIN,
    [GENERATE_SCRIPT, "--site-id", siteId, "--run-dir", runRoot, "--emit", "ts", "--force"],
    { cwd: REPO_ROOT, encoding: "utf8" }
  );
  return { stdout: result.stdout, status: result.status };
}

let workDir: string | null = null;
let siteOutDir: string | null = null;

afterEach(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
  if (siteOutDir) rmSync(siteOutDir, { recursive: true, force: true });
  workDir = null;
  siteOutDir = null;
});

const GENUINE_GRAPHQL_CAPTURE_COUNT = 10;
const COINCIDENTAL_QUERY_FIELD_REST_CAPTURE_COUNT = 10;

describe("isGraphQL() — exact-half genuine GraphQL vs. coincidental-query-field REST own-backend traffic", () => {
  it("classifies as GraphQL when genuinely-parsed GraphQL captures are exactly half of the query-bearing own-backend voting pool", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-genuine-graphql-majority-traffic-e2e-"));
    const runRoot = join(workDir, "run");
    mkdirSync(join(runRoot, "graphql"), { recursive: true });
    mkdirSync(join(runRoot, "replays"), { recursive: true });
    mkdirSync(join(runRoot, "aux"), { recursive: true });
    writeFileSync(join(runRoot, "replays", "rate-limit.json"), JSON.stringify([]));

    for (let i = 0; i < GENUINE_GRAPHQL_CAPTURE_COUNT; i++) {
      writeFileSync(
        join(runRoot, "graphql", `000-search-listings-${String(i).padStart(2, "0")}.json`),
        JSON.stringify(genuineGraphQLCapture(i))
      );
    }
    for (let i = 0; i < COINCIDENTAL_QUERY_FIELD_REST_CAPTURE_COUNT; i++) {
      writeFileSync(
        join(runRoot, "graphql", `999-search-listings-noise-${i}.json`),
        JSON.stringify(coincidentalQueryFieldRestCapture(i))
      );
    }

    const siteId = `genuine-graphql-majority-traffic-e2e-test-${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    expect(existsSync(siteOutDir)).toBe(false);
    const { stdout, status } = runGenerate(runRoot, siteId, siteOutDir);

    expect(status, stdout).toBe(0);
    expect(stdout).toContain(`generating plugin for ${siteId} (GraphQL,`);
  });
});
