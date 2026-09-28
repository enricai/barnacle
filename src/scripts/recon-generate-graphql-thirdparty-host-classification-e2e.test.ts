import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

/**
 * End-to-end proof that isGraphQL() (recon-generate.ts) is scoped to
 * own-backend-host provenance. Before the fix, isGraphQL() scanned ALL
 * captures with no host filter, so a third-party host (chat widget,
 * analytics SDK) issuing REAL GraphQL requests (a populated operationName
 * and query field, unlike the plain-GET decoy in
 * recon-generate-nongraphql-thirdparty-decoy-host-provenance-e2e.test.ts)
 * flipped the whole flow's classification to GraphQL even though the site's
 * own backend is plain REST/JSON, starving the REST action-sequence
 * extractor and submit-pattern matcher of the real captures.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const OWN_BACKEND_HOST = "www.own-backend-rest.example.com";
const THIRD_PARTY_HOST = "chat.third-party-gql-widget.example.net";

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
 * A run dir with real GraphQL POST captures on a distinct third-party host
 * (populated operationName/query, unlike the plain-GET decoy fixture) and a
 * plain REST GET capture on the own-backend host. The third-party GraphQL
 * traffic fires first and outnumbers the own-backend capture, matching a
 * chat widget or analytics SDK making real GraphQL calls alongside a REST
 * backend.
 */
function writeRunDir(root: string): void {
  mkdirSync(join(root, "graphql"), { recursive: true });
  mkdirSync(join(root, "replays"), { recursive: true });
  mkdirSync(join(root, "aux"), { recursive: true });
  writeFileSync(join(root, "replays", "rate-limit.json"), JSON.stringify([]));

  const thirdPartyGraphQL = graphqlCapture({
    phase: "home",
    url: `https://${THIRD_PARTY_HOST}/graphql`,
    operationName: "TrackWidgetEvent",
    query: "mutation TrackWidgetEvent($event: String!) { trackEvent(event: $event) { ok } }",
    responseBody: { data: { trackEvent: { ok: true } } },
  });
  for (let i = 0; i < 5; i++) {
    writeFileSync(
      join(root, "graphql", `000-home-widget-${String(i).padStart(2, "0")}.json`),
      JSON.stringify(thirdPartyGraphQL)
    );
  }

  const ownBackendSearch = restCapture({
    phase: "search-listings",
    method: "GET",
    url: `https://${OWN_BACKEND_HOST}/api/listings/search`,
    status: 200,
    responseBody: { listings: [{ id: "1", name: "Unit A" }] },
  });
  writeFileSync(
    join(root, "graphql", "100-search-listings-action.json"),
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

describe("recon-generate CLI — third-party host GraphQL traffic must never flip own-backend REST classification", () => {
  it("resolves the flow as REST and never emits the third-party GraphQL host", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-graphql-thirdparty-host-e2e-"));
    const runRoot = join(workDir, "run");
    writeRunDir(runRoot);

    const siteId = `graphql-thirdparty-host-e2e-test-${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    expect(existsSync(siteOutDir)).toBe(false);
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

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);

    expect(result.stdout).toContain(`generating plugin for ${siteId} (single-endpoint REST,`);
    expect(result.stdout).not.toContain(`generating plugin for ${siteId} (GraphQL,`);

    const contract = readFileSync(join(siteOutDir, "contract.ts"), "utf8");

    // The generated hot path traces to the own-backend REST endpoint via a
    // plain HTTP client, not the GraphQL client createGraphqlClient() emits
    // when isGraphQL() misclassifies the flow.
    expect(contract).toContain(`https://${OWN_BACKEND_HOST}`);
    expect(contract).toContain("/api/listings/search");
    expect(contract).not.toContain("createGraphqlClient");

    // Zero occurrences of the third-party GraphQL host or its operation --
    // it never became baseUrl, endpoint, query, or a fixture, and the flow
    // was never classified as GraphQL because of it.
    expect(contract).not.toContain(THIRD_PARTY_HOST);
    expect(contract).not.toContain("TrackWidgetEvent");
  }, 30_000);
});
