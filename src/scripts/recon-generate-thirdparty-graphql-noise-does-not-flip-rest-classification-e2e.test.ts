import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

/**
 * Pins isGraphQL() (recon-generate.ts) to own-backend-host provenance by
 * outnumbering a plain REST/JSON own-backend flow with a large volume of
 * GraphQL-shaped noise (real, non-null operationName/query, unlike the
 * plain-GET decoys other host-provenance tests use) from an unrelated
 * third-party host. Asserts the full generated hot path -- both what the
 * REST client emission contains and every GraphQL-only token it must not --
 * not just the classification log line, mirroring the fixture idiom of
 * recon-generate-facet-search-vs-nongraphql-thirdparty-and-sibling-query-incident-e2e.test.ts.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const OWN_BACKEND_HOST = "www.catalog-rest-fixture.example.com";
const THIRD_PARTY_HOST = "widget.gql-noise-fixture.example.net";

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

function graphqlCapture(overrides: {
  phase: string;
  url: string;
  operationName: string;
  query: string;
  responseBody: unknown;
}) {
  return {
    timestamp: "2026-08-18T10:23:02.000Z",
    phase: overrides.phase,
    method: "POST",
    url: overrides.url,
    status: 200,
    requestHeaders: { "Content-Type": "application/json" },
    requestPostData: JSON.stringify({
      operationName: overrides.operationName,
      query: overrides.query,
    }),
    responseHeaders: {},
    responseBody: overrides.responseBody,
    operationName: overrides.operationName,
    query: overrides.query,
    variables: null,
    decodedParams: null,
  };
}

/**
 * A run dir where the third-party GraphQL noise both fires first and
 * outnumbers the own-backend REST capture 10-to-1, matching the reported
 * incident's shape -- a chatty analytics SDK making real GraphQL requests
 * alongside a plain REST backend.
 */
function writeRunDir(root: string): void {
  mkdirSync(join(root, "graphql"), { recursive: true });
  mkdirSync(join(root, "replays"), { recursive: true });
  mkdirSync(join(root, "aux"), { recursive: true });
  writeFileSync(join(root, "replays", "rate-limit.json"), JSON.stringify([]));

  const thirdPartyGraphQL = graphqlCapture({
    phase: "home",
    url: `https://${THIRD_PARTY_HOST}/graphql`,
    operationName: "RecordImpression",
    query: "mutation RecordImpression($slot: String!) { recordImpression(slot: $slot) { ok } }",
    responseBody: { data: { recordImpression: { ok: true } } },
  });
  for (let i = 0; i < 10; i++) {
    writeFileSync(
      join(root, "graphql", `000-home-noise-${String(i).padStart(2, "0")}.json`),
      JSON.stringify(thirdPartyGraphQL)
    );
  }

  const ownBackendSearch = restCapture({
    phase: "search-catalog",
    method: "GET",
    url: `https://${OWN_BACKEND_HOST}/api/catalog/search`,
    status: 200,
    responseBody: { items: [{ id: "1", name: "Widget A" }] },
  });
  writeFileSync(
    join(root, "graphql", "100-search-catalog-action.json"),
    JSON.stringify(ownBackendSearch)
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

describe("recon-generate CLI — third-party GraphQL-shaped noise must never flip an own-backend REST flow's classification", () => {
  it("stays on the REST hot path and emits zero GraphQL scaffolding or third-party host content", () => {
    workDir = mkdtempSync(
      join(tmpdir(), "barnacle-thirdparty-graphql-noise-rest-classification-e2e-")
    );
    const runRoot = join(workDir, "run");
    writeRunDir(runRoot);

    const siteId = `thirdparty-graphql-noise-rest-classification-e2e-test-${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    expect(existsSync(siteOutDir)).toBe(false);
    mkdirSync(siteOutDir, { recursive: true });
    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({
        steps: [{ step: "search catalog" }],
        ownBackendHostnames: [OWN_BACKEND_HOST],
      })
    );

    const result = spawnSync(
      TSX_BIN,
      [GENERATE_SCRIPT, "--site-id", siteId, "--run-dir", runRoot, "--emit", "ts", "--force"],
      { cwd: REPO_ROOT, encoding: "utf8" }
    );

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);

    expect(result.stdout).toContain(`generating plugin for ${siteId} (single-endpoint REST,`);
    expect(result.stdout).not.toContain("GraphQL");

    const contract = readFileSync(join(siteOutDir, "contract.ts"), "utf8");

    // The own-backend REST endpoint is reached via the plain HTTP client.
    expect(contract).toContain("createHttpClient");
    expect(contract).toContain("await httpClient(");
    expect(contract).toContain(`https://${OWN_BACKEND_HOST}`);
    expect(contract).toContain("/api/catalog/search");

    // None of the GraphQL-only emission scaffolding is present.
    expect(contract).not.toContain("createGraphqlClient");
    expect(contract).not.toContain("GqlFn");
    expect(contract).not.toContain("getGql");

    // Zero occurrences of the third-party host or its operation -- it never
    // became baseUrl, endpoint, query, or a fixture.
    expect(contract).not.toContain(THIRD_PARTY_HOST);
    expect(contract).not.toContain("RecordImpression");
  }, 30_000);
});
