import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

/**
 * End-to-end proof that the own-backend provenance gate holds even when the
 * outranking third-party candidate isn't GraphQL-shaped at all -- no
 * operationName, no query field, a plain GET -- the exact incident shape of
 * a bare SDK/analytics-style host with far more captures than the real
 * backend. A capture set with every operationName null never satisfies
 * isGraphQL(), so generation takes the non-GraphQL REST path and resolves
 * baseUrl/endpoint through deriveBaseUrl and firstEndpointCapture/
 * firstEndpointPath's host gates directly, never through
 * selectPrimaryGraphQLOperation's query!==null filter. Mirrors the
 * spawnSync-CLI fixture idiom of recon-generate-facet-search-cross-host-
 * incident-e2e.test.ts.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const OWN_BACKEND_HOST = "www.own-backend-fixture.example.com";
const THIRD_PARTY_HOST = "sdk.third-party-decoy.example.net";

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
 * A run dir with one own-backend REST GET action and 20 bare GET decoy
 * captures on a distinct third-party host -- no operationName, no query
 * field, plain GET, mirroring a feature-flag/analytics SDK, not a GraphQL
 * POST. The decoy vastly outnumbers the own-backend capture and fires
 * first chronologically, matching a real recon walk where an analytics SDK
 * beacon fires before the real backend call.
 */
function writeRunDir(root: string): void {
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

describe("recon-generate CLI — non-GraphQL third-party decoy host must never win baseUrl/endpoint", () => {
  it("resolves baseUrl and endpoint to the own-backend host and never emits the decoy hostname", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-nongraphql-thirdparty-decoy-host-e2e-"));
    const runRoot = join(workDir, "run");
    writeRunDir(runRoot);

    const siteId = `nongraphql-thirdparty-decoy-host-e2e-test-${process.pid}`;
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

    const contract = readFileSync(join(siteOutDir, "contract.ts"), "utf8");

    // The generated hot path's endpoint and defaultBaseUrl trace to the
    // own-backend host, derived from deriveBaseUrl / firstEndpointCapture's
    // host gates, not the chronologically-first, far-more-frequent
    // third-party decoy.
    expect(contract).toContain(`https://${OWN_BACKEND_HOST}`);
    expect(contract).toContain("/api/listings/search");

    // Zero occurrences of the third-party decoy host anywhere in the
    // emission -- it never became baseUrl, endpoint, or a fixture.
    expect(contract).not.toContain(THIRD_PARTY_HOST);
    expect(contract).not.toContain("collect/flags");
  }, 30_000);
});
