import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import type { Capture } from "@/scripts/recon-shared";

/**
 * Locks in the reported scenario's other trigger: a flow that declares
 * `submitStep: true` on a filter-verification step (mirroring a facet
 * verification step in a real recon-flow) while every capture is a
 * query — zero mutation-shaped captures. `isReadOnlyFlow` used to flip to
 * false purely because a step declared `submitStep`, skipping
 * `selectPrimaryGraphQLOperation`'s own-backend gate entirely and falling
 * to the ungated chronological-first fallback. Exercises the real
 * `recon:generate` CLI so the full submitStep/mutation-sequence wiring is
 * covered end to end, not just the selector in isolation.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const OWN_HOST = "shop.example.com";
const THIRD_PARTY_HOST = "flags.thirdparty-sdk.example";

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

describe("recon-generate submitStep-declared read-only flow host provenance CLI e2e", () => {
  it("never selects the third-party host as the primary endpoint when a submitStep flow yields zero mutations", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-recon-submitstep-readonly-provenance-e2e-"));
    const runRoot = join(workDir, "run");
    const capturesDir = join(runRoot, "graphql");
    mkdirSync(capturesDir, { recursive: true });
    mkdirSync(join(runRoot, "replays"), { recursive: true });
    mkdirSync(join(runRoot, "aux"), { recursive: true });
    writeFileSync(join(runRoot, "replays", "rate-limit.json"), JSON.stringify([]));

    // Third-party captures come FIRST in read order, and outnumber the
    // own-backend captures heavily -- the exact conditions under which the
    // ungated chronological-first fallback (firstEndpointPath/
    // firstGraphQLQuery, which just returns the first array match) would
    // pick the third-party endpoint path were selectPrimaryGraphQLOperation
    // skipped. Every capture is a query (no `mutation` prefix), so
    // extractGraphQLActionSequence always yields an empty sequence --
    // baseUrl derivation (deriveBaseUrl, keyed on the very first capture)
    // is a separate, unrelated mechanism and is not asserted on here.
    const thirdPartyCaptures = Array.from({ length: 20 }, (_, i) => thirdPartyCapture(i));
    const ownCaptures = Array.from({ length: 3 }, (_, i) => ownBackendCapture(i));
    const allCaptures = [...thirdPartyCaptures, ...ownCaptures];
    allCaptures.forEach((capture, index) => {
      const filename = `${String(index).padStart(3, "0")}-capture.json`;
      writeFileSync(join(capturesDir, filename), JSON.stringify(capture));
    });

    const siteId = `recon-submitstep-readonly-provenance-e2e-test-${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    mkdirSync(siteOutDir, { recursive: true });
    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({
        ownBackendHostnames: [OWN_HOST],
        steps: [
          { step: "select 'widgets' from the Category dropdown", payloadField: "category" },
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

    expect(contract).toContain("SearchResults");
    expect(contract).toMatch(/endpoint: .*\/graphql`/);
    expect(contract).not.toContain(THIRD_PARTY_PATH);
  }, 30_000);
});
