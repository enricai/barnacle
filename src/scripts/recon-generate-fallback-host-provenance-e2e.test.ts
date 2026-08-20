import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import type { Capture } from "@/scripts/recon-shared";

/**
 * Locks in the reported scenario's other half at the CLI boundary:
 * `selectPrimaryGraphQLOperation` finding no candidate (all query captures
 * are non-2xx, an unrelated reason) forces generation onto the raw,
 * unfiltered "first capture in array order" fallbacks -- deriveBaseUrl,
 * firstEndpointPath/firstEndpointCapture, and firstGraphQLQuery. A
 * third-party host's capture sorts first in the raw array; without a
 * host-provenance gate on those fallbacks, it would win baseUrl/endpoint/
 * query the same way a LaunchDarkly SDK path won the reported hot path.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const OWN_HOST = "shop.example.com";
const THIRD_PARTY_HOST = "flags.thirdparty-sdk.example";
const THIRD_PARTY_PATH = "/msdk/big-segments";

function thirdPartyCapture(): Capture {
  return {
    timestamp: "2026-01-01T00:00:00.000Z",
    phase: "browse",
    method: "POST",
    url: `https://${THIRD_PARTY_HOST}${THIRD_PARTY_PATH}`,
    // A non-2xx status excludes this from selectPrimaryGraphQLOperation's
    // own candidate list for an unrelated reason (its status filter), so
    // the primary-selection path returns null and generation falls through
    // to the raw, unfiltered helpers this test targets.
    status: 404,
    requestHeaders: {},
    requestPostData: null,
    responseHeaders: { "content-type": "application/json" },
    operationName: null,
    query: "query Config { flags { enabled } }",
    variables: null,
    responseBody: { flags: { enabled: true } },
    decodedParams: null,
  };
}

// Establishes isGraphQL()'s "any capture has an operationName" flag without
// itself being eligible for any of the three fallback picks (no query body,
// so firstGraphQLQuery skips it; GET, so it never enters firstEndpointCapture/
// firstEndpointPath's non-GET-first pass).
function gqlFlagCapture(): Capture {
  return {
    timestamp: "2026-01-01T00:00:01.000Z",
    phase: "browse",
    method: "GET",
    url: `https://${OWN_HOST}/graphql/ping`,
    status: 200,
    requestHeaders: {},
    requestPostData: null,
    responseHeaders: { "content-type": "application/json" },
    operationName: "Ping",
    query: null,
    variables: null,
    responseBody: { ok: true },
    decodedParams: null,
  };
}

function ownBackendCapture(): Capture {
  return {
    timestamp: "2026-01-01T00:00:02.000Z",
    phase: "filter",
    method: "POST",
    url: `https://${OWN_HOST}/graphql`,
    status: 404,
    requestHeaders: {},
    requestPostData: null,
    responseHeaders: { "content-type": "application/json" },
    operationName: null,
    query: "query SearchResults($filters: String) { results(filters: $filters) { id name } }",
    variables: { filters: "category:widgets" },
    responseBody: { results: [{ id: "1", name: "Widget" }] },
    decodedParams: null,
  };
}

let workDir: string | null = null;
let siteOutDir: string | null = null;

afterEach(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
  if (siteOutDir) rmSync(siteOutDir, { recursive: true, force: true });
  workDir = null;
  siteOutDir = null;
});

describe("recon-generate raw-fallback host provenance CLI e2e", () => {
  it("never selects a third-party host's capture as baseUrl/endpoint/query source, even when the primary-selection path returns null", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-recon-fallback-host-provenance-e2e-"));
    const runRoot = join(workDir, "run");
    const capturesDir = join(runRoot, "graphql");
    mkdirSync(capturesDir, { recursive: true });
    mkdirSync(join(runRoot, "replays"), { recursive: true });
    mkdirSync(join(runRoot, "aux"), { recursive: true });
    writeFileSync(join(runRoot, "replays", "rate-limit.json"), JSON.stringify([]));

    // Third-party capture written first in raw array order, own-backend
    // captures sorting later -- exactly the ordering an unfiltered
    // "first capture in array" fallback would get wrong.
    const captures = [
      thirdPartyCapture(),
      gqlFlagCapture(),
      ownBackendCapture(),
      ownBackendCapture(),
    ];
    captures.forEach((capture, index) => {
      const filename = `${String(index).padStart(3, "0")}-capture.json`;
      writeFileSync(join(capturesDir, filename), JSON.stringify(capture));
    });

    const siteId = `recon-fallback-host-provenance-e2e-test-${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    mkdirSync(siteOutDir, { recursive: true });
    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({ ownBackendHostnames: [OWN_HOST], steps: [] })
    );

    const result = spawnSync(
      TSX_BIN,
      [GENERATE_SCRIPT, "--site-id", siteId, "--run-dir", runRoot, "--emit", "ts", "--force"],
      { cwd: REPO_ROOT, encoding: "utf8" }
    );

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);

    const contract = readFileSync(join(siteOutDir, "contract.ts"), "utf8");

    expect(contract).toContain("SearchResults");
    expect(contract).not.toContain(THIRD_PARTY_HOST);
    expect(contract).not.toContain(THIRD_PARTY_PATH);
    expect(contract).toContain(OWN_HOST);
    expect(contract).toContain("baseUrl}/graphql");
  }, 30_000);
});
