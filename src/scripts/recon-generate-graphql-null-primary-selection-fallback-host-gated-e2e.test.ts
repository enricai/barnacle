import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import type { Capture } from "@/scripts/recon-shared";

/**
 * Locks in the exact reported incident shape end to end: a submitStep-declared
 * read-only flow whose one genuine own-backend mutation capture (matching
 * submitEndpointPattern/submitBodyPattern) makes `graphqlActionSequence.length
 * !== 0`, which unconditionally nulls `selectPrimaryGraphQLOperation` and
 * forces generation onto `firstGraphQLQuery`/`firstEndpointPath`'s
 * chronological-first fallback. A third-party host capture sorts first and
 * outnumbers the real own-backend facet-bearing search, and carries its own
 * query text so it can win the fallback outright when ungated — exactly the
 * shape that let a LaunchDarkly SDK path outrank `/cruises/graph` in the
 * reported incident. Asserts the fallback stays
 * host-gated and internally coherent: endpoint, query, and operationName all
 * resolve to the SAME own-backend capture.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const OWN_HOST = "catalog.example.com";
const THIRD_PARTY_HOST = "flags.thirdparty-sdk.example";
const THIRD_PARTY_PATH = "/msdk/big-segments";

const FACET_QUERY =
  "query SearchResults($filters: String) { results(filters: $filters) { id name } }";

// Chronologically first, and more numerous than the real search captures — a
// third-party analytics/feature-flag-style POST that carries its own query
// text (so it CAN win firstGraphQLQuery/firstEndpointCapture's chronological-
// first fallback outright) but is never routed through
// selectPrimaryGraphQLOperation at all in this scenario (that selector is
// unconditionally bypassed once the mutation capture below makes
// graphqlActionSequence non-empty). It must only be excludable via
// host-provenance gating on the raw fallback helpers themselves.
function thirdPartyCapture(index: number): Capture {
  return {
    timestamp: `2026-01-01T00:00:${String(index).padStart(2, "0")}.000Z`,
    phase: "browse",
    method: "POST",
    url: `https://${THIRD_PARTY_HOST}${THIRD_PARTY_PATH}`,
    status: 200,
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

// The real, facet-bearing search on the own backend — sent inline with no
// top-level operationName, mirroring the reported incident's filtered query.
function ownFacetSearchCapture(index: number): Capture {
  return {
    timestamp: `2026-01-01T00:10:${String(index).padStart(2, "0")}.000Z`,
    phase: "filter",
    method: "POST",
    url: `https://${OWN_HOST}/graphql`,
    status: 200,
    requestHeaders: {},
    requestPostData: null,
    responseHeaders: { "content-type": "application/json" },
    operationName: null,
    query: FACET_QUERY,
    variables: { filters: "category:widgets" },
    responseBody: {
      results: Array.from({ length: 3 }, (_, i) => ({ id: `${index}-${i}`, name: `Widget ${i}` })),
    },
    decodedParams: null,
  };
}

// The single genuine mutation capture: it matches submitEndpointPattern and
// submitBodyPattern, so extractGraphQLActionSequence's length becomes
// non-zero, which is what forces primaryGraphQLOperation to null and pushes
// generation onto the raw chronological-first fallback under test. It also
// carries an operationName so isGraphQL() flips true.
function ownMutationCapture(): Capture {
  return {
    timestamp: "2026-01-01T00:20:00.000Z",
    phase: "filter",
    method: "POST",
    url: `https://${OWN_HOST}/graphql`,
    status: 200,
    requestHeaders: {},
    requestPostData: "mutation logSearchImpression { logSearchImpression(input: {}) { ok } }",
    responseHeaders: { "content-type": "application/json" },
    operationName: "logSearchImpression",
    query: "mutation logSearchImpression { logSearchImpression(input: {}) { ok } }",
    variables: null,
    responseBody: { logSearchImpression: { ok: true } },
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

describe("recon-generate graphql null-primary-selection fallback host-gated CLI e2e", () => {
  it("keeps the ungated chronological-first fallback host-gated and coherent when the primary-operation selector is bypassed by a genuine mutation", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-recon-null-primary-fallback-host-gated-e2e-"));
    const runRoot = join(workDir, "run");
    const capturesDir = join(runRoot, "graphql");
    mkdirSync(capturesDir, { recursive: true });
    mkdirSync(join(runRoot, "replays"), { recursive: true });
    mkdirSync(join(runRoot, "aux"), { recursive: true });
    writeFileSync(join(runRoot, "replays", "rate-limit.json"), JSON.stringify([]));

    // Third-party captures come first in read order and heavily outnumber
    // the own-backend search — exactly the ordering an ungated
    // chronological-first fallback would get wrong.
    const thirdPartyCaptures = Array.from({ length: 20 }, (_, i) => thirdPartyCapture(i));
    const ownSearchCaptures = Array.from({ length: 2 }, (_, i) => ownFacetSearchCapture(i));
    const allCaptures = [...thirdPartyCaptures, ...ownSearchCaptures, ownMutationCapture()];
    allCaptures.forEach((capture, index) => {
      const filename = `${String(index).padStart(3, "0")}-capture.json`;
      writeFileSync(join(capturesDir, filename), JSON.stringify(capture));
    });

    const siteId = `recon-null-primary-fallback-host-gated-e2e-test-${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    mkdirSync(siteOutDir, { recursive: true });
    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({
        ownBackendHostnames: [OWN_HOST],
        submitEndpointPattern: "/graphql",
        submitBodyPattern: '"?logSearchImpression"?\\s*[:(]',
        steps: [
          { step: "select 'widgets' from the Category filter", payloadField: "category" },
          { step: "verify the filtered results are visible", submitStep: true },
        ],
      })
    );

    const result = spawnSync(
      TSX_BIN,
      [GENERATE_SCRIPT, "--site-id", siteId, "--run-dir", runRoot, "--emit", "ts", "--force"],
      { cwd: REPO_ROOT, encoding: "utf8" }
    );

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);

    const contract = readFileSync(join(siteOutDir, "contract.ts"), "utf8");

    // The endpoint, embedded query text, and operationName literal must all
    // resolve to the SAME own-backend facet-bearing capture.
    expect(contract).toMatch(/endpoint: .*\/graphql`/);
    expect(contract).toContain(OWN_HOST);
    expect(contract).toContain("SearchResults");
    expect(contract).toContain("results(filters: $filters)");

    // Never anywhere in the file — not as endpoint, not as a stray literal.
    expect(contract).not.toContain(THIRD_PARTY_HOST);
    expect(contract).not.toContain(THIRD_PARTY_PATH);
  }, 30_000);
});
