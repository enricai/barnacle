import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

/**
 * End-to-end proof of the report's exact composite incident: an own-backend
 * host is favored over a far more frequent third-party GraphQL-shaped host,
 * and a facet-bearing search on that own-backend host wins primary selection
 * over the named landing query -- with every facet-bearing capture's `query`
 * field `#`-comment-prefixed and its top-level `operationName` null, the one
 * shape the sibling recon-generate-facet-search-cross-host-incident-e2e.test.ts
 * does not cover. Proves the comment-prefix parsing fix by asserting the
 * emitted contract carries the real parsed operation name and real facet
 * variable wiring instead of the fabricated `${pascal}Search` / `{ q:
 * payload.query }` fallback triggered when a null operationName can't be
 * recovered from the (comment-prefixed) query body.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const OWN_BACKEND_HOST = "www.own-backend-fixture.example.com";
const THIRD_PARTY_HOST = "gql.third-party-tracker.example.net";
const LANDING_OPERATION_NAME = "listingSearch_Listings";
const FILTERED_OPERATION_NAME = "listingSearch_Filtered";
const LANDING_QUERY_TEXT =
  "query listingSearch_Listings($metro: String) { listings(metro: $metro) { id name } }";
const COMMENT_PREFIXED_FILTERED_QUERY_TEXT = `# ${FILTERED_OPERATION_NAME}\nquery ${FILTERED_OPERATION_NAME}($metro: String) { listings(metro: $metro) { id name } }`;

function gqlCapture(overrides: {
  phase: string;
  url: string;
  operationName: string | null;
  query: string | null;
  variables: Record<string, unknown> | null;
  responseLength: number;
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
    responseBody: { pad: "x".repeat(Math.max(0, overrides.responseLength - '{"pad":""}'.length)) },
    operationName: overrides.operationName,
    query: overrides.query,
    variables: overrides.variables,
    decodedParams: null,
  };
}

/**
 * The report's own repro: a named unfiltered landing query on the
 * own-backend host, ~16 POSTs to a distinct, far more frequent third-party
 * host sharing the landing query's operationName/shape, and 24
 * operationName:null, `#`-comment-prefixed, facet-bearing filtered-search
 * POSTs on the own-backend host.
 */
function writeIncidentRunDir(root: string): void {
  mkdirSync(join(root, "graphql"), { recursive: true });
  mkdirSync(join(root, "replays"), { recursive: true });
  mkdirSync(join(root, "aux"), { recursive: true });
  writeFileSync(join(root, "replays", "rate-limit.json"), JSON.stringify([]));

  // The landing capture fires first, chronologically -- it decides the
  // derived base URL, matching a real recon walk where the entry page loads
  // before any filter or third-party tracker call.
  const unfilteredLandingQuery = gqlCapture({
    phase: "open-the-metro-filter",
    url: `https://${OWN_BACKEND_HOST}/x/graph`,
    operationName: LANDING_OPERATION_NAME,
    query: LANDING_QUERY_TEXT,
    variables: { metro: null },
    responseLength: 61440,
  });
  writeFileSync(
    join(root, "graphql", "000-open-the-metro-filter-landing.json"),
    JSON.stringify(unfilteredLandingQuery)
  );

  const thirdPartyQuery = gqlCapture({
    phase: "open-the-metro-filter",
    url: `https://${THIRD_PARTY_HOST}/collect/graph`,
    operationName: LANDING_OPERATION_NAME,
    query: `query ${LANDING_OPERATION_NAME} { trackedEvents { id } }`,
    variables: null,
    responseLength: 2048,
  });
  for (let i = 0; i < 16; i++) {
    writeFileSync(
      join(root, "graphql", `001-open-the-metro-filter-tracker-${String(i).padStart(2, "0")}.json`),
      JSON.stringify(thirdPartyQuery)
    );
  }

  // 24 operationName:null, comment-prefixed, facet-bearing filtered-search
  // POSTs, one per metro (repeating the metro list), for 25 own-backend
  // captures total.
  const metros = ["AUSTIN", "DENVER", "SEATTLE", "BOSTON", "MIAMI", "PHOENIX"];
  for (let i = 0; i < 24; i++) {
    const metro = metros[i % metros.length];
    const facetQuery = gqlCapture({
      phase: "open-the-metro-filter",
      url: `https://${OWN_BACKEND_HOST}/x/graph`,
      operationName: null,
      query: COMMENT_PREFIXED_FILTERED_QUERY_TEXT,
      variables: { metro },
      responseLength: 61440,
    });
    writeFileSync(
      join(root, "graphql", `101-open-the-metro-filter-facet-${String(i).padStart(2, "0")}.json`),
      JSON.stringify(facetQuery)
    );
  }
}

let workDir: string | null = null;
let siteOutDir: string | null = null;

afterEach(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
  if (siteOutDir) rmSync(siteOutDir, { recursive: true, force: true });
  workDir = null;
  siteOutDir = null;
});

describe("recon-generate CLI — full incident shape with comment-prefixed, operationName:null facet captures: host gating, facet-tier priority, and comment-prefix operation-name/variable recovery", () => {
  it("emits a coherent hot path targeting the own-backend facet-bearing operation with its real comment-prefix-parsed name and real variables, with zero third-party or fabricated content", () => {
    workDir = mkdtempSync(
      join(tmpdir(), "barnacle-comment-prefixed-facet-search-cross-host-incident-e2e-")
    );
    const runRoot = join(workDir, "run");
    writeIncidentRunDir(runRoot);

    const siteId = `comment-prefixed-facet-search-cross-host-incident-e2e-test-${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    expect(existsSync(siteOutDir)).toBe(false);
    mkdirSync(siteOutDir, { recursive: true });
    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({
        steps: [{ step: "apply the metro filter", payloadField: "metro", submitStep: true }],
        ownBackendHostnames: [OWN_BACKEND_HOST],
      })
    );

    const result = spawnSync(
      TSX_BIN,
      [GENERATE_SCRIPT, "--site-id", siteId, "--run-dir", runRoot, "--emit", "ts", "--force"],
      { cwd: REPO_ROOT, encoding: "utf8" }
    );

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);

    const contract = readFileSync(join(siteOutDir, "contract.ts"), "utf8");

    // The comment-prefix-parsed filtered-search operation name and real
    // filter variable wiring are present -- recovered from the query body
    // despite the null top-level operationName field and the leading `#`
    // comment line.
    expect(contract).toContain(`"${FILTERED_OPERATION_NAME}"`);
    expect(contract).toMatch(/\{\s*metro:\s*payload\.metro\s*\}/);
    expect(contract).toMatch(/endpoint: .*\/x\/graph/);

    // Zero occurrences of the third-party host anywhere in the emission.
    expect(contract).not.toContain(THIRD_PARTY_HOST);
    expect(contract).not.toContain("trackedEvents");

    // No fabricated `${pascal}Search`-shaped literal and no unwired
    // `{ q: payload.query }` fallback -- the comment-prefix parse gap, if
    // unfixed, forces exactly this fabrication path.
    expect(contract).not.toMatch(/"[A-Za-z]*Search"/);
    expect(contract).not.toContain("{ q: payload.query }");
  }, 30_000);
});
