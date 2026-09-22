import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

/**
 * Pins the reported `query.replace is not a function` crash: a third-party
 * capture whose top-level `query` field is a JSON object (not a GraphQL
 * string) must not reach the string-only code paths
 * (declaredOperationVariableNames/stripLeadingGraphQLComments) that assume
 * `capture.query` is always a string. Mirrors the spawnSync-CLI fixture
 * idiom of
 * recon-generate-facet-search-vs-nongraphql-thirdparty-and-sibling-query-incident-e2e.test.ts.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const OWN_BACKEND_HOST = "www.own-backend-fixture.example.com";
const THIRD_PARTY_HOST = "sdk.analytics-decoy.example.net";
const OWN_OPERATION_NAME = "FilteredSearch";
const OWN_QUERY_TEXT =
  "query FilteredSearch($metro: String) { listings(metro: $metro) { id name } }";

function gqlCapture(overrides: {
  phase: string;
  url: string;
  operationName: string | null;
  query: unknown;
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
 * Two capture groups: (a) 20 own-backend GraphQL captures for the real
 * winning operation, with a normal string `query`; (b) 20 third-party
 * captures whose `query` field is a nested JSON object -- the exact shape
 * that previously reached `.replace()` on a non-string and crashed
 * recon-generate.
 */
function writeIncidentRunDir(root: string): void {
  mkdirSync(join(root, "graphql"), { recursive: true });
  mkdirSync(join(root, "replays"), { recursive: true });
  mkdirSync(join(root, "aux"), { recursive: true });
  writeFileSync(join(root, "replays", "rate-limit.json"), JSON.stringify([]));

  const objectQueryCapture = gqlCapture({
    phase: "home",
    url: `https://${THIRD_PARTY_HOST}/collect/events`,
    operationName: null,
    query: { identity: { fetch: ["a"] } },
    variables: null,
    responseLength: 512,
  });
  for (let i = 0; i < 20; i++) {
    writeFileSync(
      join(root, "graphql", `000-home-decoy-${String(i).padStart(2, "0")}.json`),
      JSON.stringify(objectQueryCapture)
    );
  }

  const ownQuery = gqlCapture({
    phase: "open-the-metro-filter",
    url: `https://${OWN_BACKEND_HOST}/x/graph`,
    operationName: OWN_OPERATION_NAME,
    query: OWN_QUERY_TEXT,
    variables: { metro: "AUSTIN" },
    responseLength: 61440,
  });
  for (let i = 0; i < 20; i++) {
    writeFileSync(
      join(root, "graphql", `100-open-the-metro-filter-winner-${String(i).padStart(2, "0")}.json`),
      JSON.stringify(ownQuery)
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

describe("recon-generate CLI — third-party capture with a non-string (object) query field", () => {
  it("exits 0 instead of crashing on query.replace, and emits a contract anchored on the own-backend operation only", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-non-string-query-field-crash-regression-e2e-"));
    const runRoot = join(workDir, "run");
    writeIncidentRunDir(runRoot);

    const siteId = `non-string-query-field-crash-regression-e2e-test-${process.pid}`;
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
    expect(`${result.stdout}\n${result.stderr}`).not.toContain("query.replace is not a function");

    const contract = readFileSync(join(siteOutDir, "contract.ts"), "utf8");

    // Endpoint and defaultBaseUrl trace to the own-backend host and path.
    expect(contract).toContain(`https://${OWN_BACKEND_HOST}`);
    expect(contract).toMatch(/endpoint: .*\/x\/graph/);
    expect(contract).toContain(`"${OWN_OPERATION_NAME}"`);
    expect(contract).toContain("listings(metro: $metro)");

    // Zero occurrences of the object-query third-party capture's host or
    // content anywhere in the emission.
    expect(contract).not.toContain(THIRD_PARTY_HOST);
    expect(contract).not.toContain("collect/events");
    expect(contract).not.toContain("identity");
  }, 30_000);
});
