import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import type { Capture } from "@/scripts/recon-shared";

/**
 * Once selectPrimaryGraphQLOperation returns null (no 2xx query candidate),
 * generation falls through to the raw fallbacks -- firstGraphQLQuery,
 * firstEndpointPath/firstEndpointCapture, and a hardcoded null operationName.
 * Those are three independent lookups over `captures` with no shared-capture
 * invariant: nothing stops the query text and the endpoint path resolving to
 * two unrelated captures, or the operationName being left null/placeholder
 * even when the winning query's own body names the operation. This locks in
 * that the resolved {query, endpointPath, operationName} triple all trace
 * back to the SAME own-backend capture.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const OWN_HOST = "shop.example.com";
const UNRELATED_PATH = "/graphql/track";
const REAL_PATH = "/graphql";
const REAL_OPERATION_NAME = "SearchResults";
const REAL_QUERY = `query ${REAL_OPERATION_NAME}($filters: String) { results(filters: $filters) { id name } }`;

// Establishes isGraphQL()'s "any capture has an operationName" flag without
// being eligible for any of the three fallback picks: GET, so it never
// enters firstEndpointCapture/firstEndpointPath's non-GET-first pass, and
// carries no query, so firstGraphQLQuery skips it.
function gqlFlagCapture(): Capture {
  return {
    timestamp: "2026-01-01T00:00:00.000Z",
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

// Earliest non-GET capture: an own-backend endpoint unrelated to the real
// search query, with no query body of its own. This is what
// firstEndpointPath/firstEndpointCapture would independently pick as "the"
// endpoint if they aren't tied to whichever capture supplies the query.
function unrelatedNonGetCapture(): Capture {
  return {
    timestamp: "2026-01-01T00:00:01.000Z",
    phase: "browse",
    method: "POST",
    url: `https://${OWN_HOST}${UNRELATED_PATH}`,
    // Non-2xx keeps this out of selectPrimaryGraphQLOperation's own
    // candidate list too, though it has no query anyway.
    status: 404,
    requestHeaders: {},
    requestPostData: null,
    responseHeaders: { "content-type": "application/json" },
    operationName: null,
    query: null,
    variables: null,
    responseBody: { tracked: true },
    decodedParams: null,
  };
}

// The real own-backend capture: GET method (so it's never reached by
// firstEndpointCapture's non-GET-first pass while unrelatedNonGetCapture
// exists), operationName null (an inline document with no separate
// top-level operationName), carrying the real facet-bearing query. A
// non-2xx status excludes it from selectPrimaryGraphQLOperation's candidate
// list, forcing generation onto the raw fallbacks this test targets.
function realFacetCapture(): Capture {
  return {
    timestamp: "2026-01-01T00:00:02.000Z",
    phase: "filter",
    method: "GET",
    url: `https://${OWN_HOST}${REAL_PATH}`,
    status: 404,
    requestHeaders: {},
    requestPostData: null,
    responseHeaders: { "content-type": "application/json" },
    operationName: null,
    query: REAL_QUERY,
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

describe("recon-generate raw-fallback primary-operation coherence", () => {
  it("resolves query, endpointPath, and operationName from the SAME capture, not three independent lookups", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-recon-fallback-coherence-e2e-"));
    const runRoot = join(workDir, "run");
    const capturesDir = join(runRoot, "graphql");
    mkdirSync(capturesDir, { recursive: true });
    mkdirSync(join(runRoot, "replays"), { recursive: true });
    mkdirSync(join(runRoot, "aux"), { recursive: true });
    writeFileSync(join(runRoot, "replays", "rate-limit.json"), JSON.stringify([]));

    // Unrelated non-GET capture written first in raw array order, the real
    // query-bearing capture sorting later -- exactly the ordering under
    // which firstEndpointPath and firstGraphQLQuery, run independently,
    // would pick two different captures.
    const captures = [gqlFlagCapture(), unrelatedNonGetCapture(), realFacetCapture()];
    captures.forEach((capture, index) => {
      const filename = `${String(index).padStart(3, "0")}-capture.json`;
      writeFileSync(join(capturesDir, filename), JSON.stringify(capture));
    });

    const siteId = `recon-fallback-coherence-e2e-test-${process.pid}`;
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

    // The query text must come from realFacetCapture.
    expect(contract).toContain(REAL_OPERATION_NAME);
    // The endpoint the GraphQL client is built against must be the SAME
    // capture's path, not unrelatedNonGetCapture's.
    expect(contract).toContain(`${REAL_PATH}\``);
    expect(contract).not.toContain(UNRELATED_PATH);
    // The operationName threaded into the getGql() call must be parsed out
    // of realFacetCapture's own query body -- not left as the generic
    // "${Pascal}Search" placeholder that only applies when there is no
    // resolvable operation name at all.
    expect(contract).toContain(`"${REAL_OPERATION_NAME}"`);
  }, 30_000);
});
