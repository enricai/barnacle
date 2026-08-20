import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import type { Capture } from "@/scripts/recon-shared";

/**
 * Locks in the reported scenario at the CLI boundary: many high-volume
 * third-party-host GraphQL captures (a decoy analytics/flag SDK) alongside a
 * smaller set of facet-bearing, operationName-null captures on the flow's own
 * backend, gated by an explicit `ownBackendHostnames` in recon-flow.json.
 * Exercises the real `recon:generate` CLI against a temp run dir rather than
 * calling selectPrimaryGraphQLOperation directly, so the full baseUrl
 * derivation + host-provenance gate + null-operationName grouping wiring is
 * covered end to end.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const OWN_HOST = "shop.example.com";
const THIRD_PARTY_HOST = "flags.thirdparty-sdk.example";

// Same operation name/query/variable shape on both hosts (a mirrored/echoed
// call, the shape the report's traffic actually had), living at a DIFFERENT
// path on the third-party host. The third-party side repeats far more often
// with a far larger response — the exact conditions under which the
// host-provenance gate is the only thing that stops recurrenceScore +
// sizeScore from outvoting the own-backend capture, since fieldScore and
// facetScore tie identically on both.
const SHARED_QUERY =
  "query SearchResults($filters: String) { results(filters: $filters) { id name } }";
const THIRD_PARTY_PATH = "/msdk/big-segments";

function ownBackendCapture(id: number): Capture {
  return {
    timestamp: "2026-01-01T00:00:00.000Z",
    phase: "filter",
    method: "POST",
    url: `https://${OWN_HOST}/graphql`,
    status: 200,
    requestHeaders: {},
    requestPostData: null,
    responseHeaders: { "content-type": "application/json" },
    operationName: null,
    query: SHARED_QUERY,
    variables: { filters: "category:widgets" },
    responseBody: {
      results: Array.from({ length: 3 }, (_, i) => ({ id: `${id}-${i}`, name: `Widget ${i}` })),
    },
    decodedParams: null,
  };
}

function thirdPartyCapture(index: number): Capture {
  return {
    timestamp: "2026-01-01T00:00:01.000Z",
    phase: "filter",
    method: "POST",
    url: `https://${THIRD_PARTY_HOST}${THIRD_PARTY_PATH}`,
    status: 200,
    requestHeaders: {},
    requestPostData: null,
    responseHeaders: { "content-type": "application/json" },
    operationName: "SearchResults",
    query: SHARED_QUERY,
    variables: { filters: "category:widgets" },
    responseBody: {
      results: Array.from({ length: 200 }, (_, i) => ({
        id: `${index}-${i}`,
        name: `Widget ${i}`,
      })),
    },
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

describe("recon-generate primary GraphQL operation provenance CLI e2e", () => {
  it("selects the own-backend operationName-null operation over a higher-volume third-party host operation", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-recon-primary-op-provenance-e2e-"));
    const runRoot = join(workDir, "run");
    const capturesDir = join(runRoot, "graphql");
    mkdirSync(capturesDir, { recursive: true });
    mkdirSync(join(runRoot, "replays"), { recursive: true });
    mkdirSync(join(runRoot, "aux"), { recursive: true });
    writeFileSync(join(runRoot, "replays", "rate-limit.json"), JSON.stringify([]));

    // Own-backend captures first, so deriveBaseUrl picks the own host even
    // though the third-party host outnumbers it heavily below.
    const ownCaptures = Array.from({ length: 3 }, (_, i) => ownBackendCapture(i));
    const thirdPartyCaptures = Array.from({ length: 20 }, (_, i) => thirdPartyCapture(i));
    const allCaptures = [...ownCaptures, ...thirdPartyCaptures];
    allCaptures.forEach((capture, index) => {
      const filename = `${String(index).padStart(3, "0")}-capture.json`;
      writeFileSync(join(capturesDir, filename), JSON.stringify(capture));
    });

    const siteId = `recon-primary-op-provenance-e2e-test-${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    mkdirSync(siteOutDir, { recursive: true });
    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({
        ownBackendHostnames: [OWN_HOST],
        steps: [{ step: "select 'widgets' from the Category dropdown", payloadField: "category" }],
      })
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
