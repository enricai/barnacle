import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

/**
 * Full reproduction of the reported incident's exact composition: an
 * own-backend host serving two distinct real GraphQL operations on the same
 * endpoint (an operationName-null facet-bearing search and a named,
 * non-facet metadata query with more captures), alongside a far more
 * frequent non-GraphQL third-party decoy host that never even satisfies
 * isGraphQL(). Only the host/facet-gated primary selection composed with
 * real body-parsed operationName resolution keeps the facet-bearing
 * own-backend search winning against both distractors simultaneously.
 * Mirrors the spawnSync-CLI fixture idiom of
 * recon-generate-facet-search-cross-host-incident-e2e.test.ts,
 * recon-generate-nongraphql-thirdparty-decoy-host-provenance-e2e.test.ts,
 * and
 * recon-generate-null-operation-facet-query-vs-unrelated-named-query-e2e.test.ts.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const OWN_BACKEND_HOST = "www.own-backend-fixture.example.com";
const THIRD_PARTY_HOST = "sdk.third-party-decoy.example.net";
const SIBLING_OPERATION_NAME = "FilterOptionsMetadata";
const FACET_QUERY_TEXT =
  "query FilteredSearch($metro: String) { listings(metro: $metro) { id name } }";

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

function restCapture(overrides: {
  phase: string;
  method: string;
  url: string;
  status: number;
  responseBody: unknown;
}) {
  return {
    timestamp: "2026-08-18T10:23:03.000Z",
    phase: overrides.phase,
    method: overrides.method,
    url: overrides.url,
    status: overrides.status,
    requestHeaders: { "Content-Type": "application/json" },
    requestPostData: null,
    responseHeaders: {},
    responseBody: overrides.responseBody,
    operationName: null,
    query: null,
    variables: null,
    decodedParams: null,
  };
}

/**
 * Three capture groups, matching the incident's exact shape: (a) 20 bare GET
 * captures on a distinct non-GraphQL third-party host, chronologically
 * first and the single largest group; (b) 20 named non-facet own-backend
 * metadata query captures sharing the winner's endpoint; (c) 6
 * operationName-null facet-bearing own-backend search captures, one per
 * metro, sharing the same endpoint as (b).
 */
function writeIncidentRunDir(root: string): void {
  mkdirSync(join(root, "graphql"), { recursive: true });
  mkdirSync(join(root, "replays"), { recursive: true });
  mkdirSync(join(root, "aux"), { recursive: true });
  writeFileSync(join(root, "replays", "rate-limit.json"), JSON.stringify([]));

  const thirdPartyBeacon = restCapture({
    phase: "home",
    method: "GET",
    url: `https://${THIRD_PARTY_HOST}/collect/flags`,
    status: 200,
    responseBody: { flags: { enabled: true } },
  });
  for (let i = 0; i < 20; i++) {
    writeFileSync(
      join(root, "graphql", `000-home-decoy-${String(i).padStart(2, "0")}.json`),
      JSON.stringify(thirdPartyBeacon)
    );
  }

  const siblingQuery = gqlCapture({
    phase: "open-the-metro-filter",
    url: `https://${OWN_BACKEND_HOST}/x/graph`,
    operationName: SIBLING_OPERATION_NAME,
    query: `query ${SIBLING_OPERATION_NAME} { filterOptions { categories { id label } } }`,
    variables: null,
    responseLength: 65536,
  });
  for (let i = 0; i < 20; i++) {
    writeFileSync(
      join(root, "graphql", `100-open-the-metro-filter-sibling-${String(i).padStart(2, "0")}.json`),
      JSON.stringify(siblingQuery)
    );
  }

  const metros = ["AUSTIN", "DENVER", "SEATTLE", "BOSTON", "MIAMI", "PHOENIX"];
  metros.forEach((metro, i) => {
    const facetQuery = gqlCapture({
      phase: "open-the-metro-filter",
      url: `https://${OWN_BACKEND_HOST}/x/graph`,
      operationName: null,
      query: FACET_QUERY_TEXT,
      variables: { metro },
      responseLength: 61440,
    });
    writeFileSync(
      join(root, "graphql", `200-open-the-metro-filter-facet-${String(i).padStart(2, "0")}.json`),
      JSON.stringify(facetQuery)
    );
  });
}

let workDir: string | null = null;
let siteOutDir: string | null = null;

afterEach(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
  if (siteOutDir) rmSync(siteOutDir, { recursive: true, force: true });
  workDir = null;
  siteOutDir = null;
});

describe("recon-generate CLI — full incident shape: facet-bearing null-operation search vs. a non-GraphQL third-party host AND a same-host non-facet named query, simultaneously", () => {
  it("emits a contract targeting only the own-backend facet-bearing search, with zero third-party or sibling-query content", () => {
    workDir = mkdtempSync(
      join(tmpdir(), "barnacle-facet-search-vs-nongraphql-and-sibling-incident-e2e-")
    );
    const runRoot = join(workDir, "run");
    writeIncidentRunDir(runRoot);

    const siteId = `facet-search-vs-nongraphql-and-sibling-incident-e2e-test-${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    expect(existsSync(siteOutDir)).toBe(false);
    mkdirSync(siteOutDir, { recursive: true });
    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({
        steps: [{ step: "apply the metro filter", payloadField: "metro" }],
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

    // Endpoint and defaultBaseUrl trace to the own-backend host and path.
    expect(contract).toContain(`https://${OWN_BACKEND_HOST}`);
    expect(contract).toMatch(/endpoint: .*\/x\/graph/);

    // The winning operation's real, body-parsed name and real facet
    // variable wiring are present -- derived from the query body, not the
    // null top-level operationName field.
    expect(contract).toContain('"FilteredSearch"');
    expect(contract).toContain("listings(metro: $metro)");
    expect(contract).toMatch(/\{\s*metro:\s*payload\.metro\s*\}/);

    // Zero occurrences of the third-party decoy host anywhere in the
    // emission.
    expect(contract).not.toContain(THIRD_PARTY_HOST);
    expect(contract).not.toContain("collect/flags");
    expect(contract).not.toContain("flags");

    // Zero occurrences of the same-host sibling non-facet query's operation
    // name or field shape, even though it shares the winner's endpoint and
    // outnumbers it in captures.
    expect(contract).not.toContain(SIBLING_OPERATION_NAME);
    expect(contract).not.toContain("filterOptions");
    expect(contract).not.toContain("categories");
  }, 30_000);
});
