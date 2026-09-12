import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";
import type { Capture } from "@/scripts/recon-shared";

/**
 * Regression for #bugfix-003: a same-host, fixed-query, zero-request-variance
 * endpoint whose path has only a single two-word compound segment (e.g. a
 * session-authenticator beacon at `.../authenticator/responder.html`) must be
 * excluded as noise. Before the fix, `isStructurallyIsolatedCapture`'s
 * "densely name-spaced" carve-out (recon-generate.ts's own-repeat exclusion)
 * only applies to paths with MORE than one compound segment's worth of
 * tokens; a path with exactly one two-word segment falls back to comparing
 * against every OTHER admitted capture by raw index, so its own N-1 identical
 * repeats "vouch" for its path tokens and it is never recognized as isolated.
 * A dedicated zero-variance detector, independent of token-overlap, is the
 * only thing that catches this shape.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const OWN_BACKEND_HOST = "www.own-backend-zero-variance-noise-exclusion.example.com";
const BEACON_URL = `https://${OWN_BACKEND_HOST}/authenticator/responder.html?clientId=WEB&environment=PROD`;
const LISTING_URL = `https://${OWN_BACKEND_HOST}/available-products/`;
const DRILL_URL = `https://${OWN_BACKEND_HOST}/available-sailings/`;

const BEACON_FIRE_COUNT = 14;
const LISTING_PAGE_COUNT = 8;
const DRILL_ITEM_COUNT = 3;

function zeroVarianceBeaconAlongsideRealChainCaptures(): Capture[] {
  const beacon = Array.from({ length: BEACON_FIRE_COUNT }, (_, i) =>
    buildCapture({
      url: BEACON_URL,
      requestPostData: "opaque-fixed-payload",
      responseBody: { ok: true },
      timestamp: `2024-01-01T00:00:${String(i).padStart(2, "0")}Z`,
    })
  );
  const listing = Array.from({ length: LISTING_PAGE_COUNT }, (_, i) =>
    buildCapture({
      url: `${LISTING_URL}?_=${1700000000 + i}`,
      requestPostData: JSON.stringify({ page: i + 1 }),
      responseBody: {
        totalPages: LISTING_PAGE_COUNT,
        products: [{ productId: `p${i + 1}` }],
      },
      timestamp: `2024-01-01T00:01:${String(i).padStart(2, "0")}Z`,
    })
  );
  const drills = Array.from({ length: DRILL_ITEM_COUNT }, (_, i) =>
    buildCapture({
      url: DRILL_URL,
      requestPostData: JSON.stringify({ productId: `p${i + 1}` }),
      responseBody: { units: [{ unitId: `s${i + 1}` }], exchangeRate: 1.0 },
      timestamp: `2024-01-01T00:02:${String(i).padStart(2, "0")}Z`,
    })
  );
  return [...beacon, ...listing, ...drills];
}

function writeRunDir(root: string, captures: Capture[]): void {
  mkdirSync(join(root, "graphql"), { recursive: true });
  mkdirSync(join(root, "replays"), { recursive: true });
  mkdirSync(join(root, "aux"), { recursive: true });
  writeFileSync(join(root, "replays", "rate-limit.json"), JSON.stringify([]));
  captures.forEach((capture, index) => {
    writeFileSync(
      join(root, "graphql", `${String(index).padStart(3, "0")}-capture.json`),
      JSON.stringify(capture)
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

describe("recon-generate CLI — zero-variance same-host beacon is excluded from the resolved pool", () => {
  it("emits the genuine chain's real endpoints while never referencing the zero-variance beacon's path, even with only a single two-word compound segment", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-zero-variance-noise-exclusion-e2e-"));
    const runRoot = join(workDir, "run");
    writeRunDir(runRoot, zeroVarianceBeaconAlongsideRealChainCaptures());

    const siteId = `zero-variance-noise-exclusion-e2e-test-${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    mkdirSync(siteOutDir, { recursive: true });
    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({
        steps: [
          { step: "browse paged product listing" },
          { step: "drill into sailing availability", submitStep: true },
        ],
        submitEndpointPattern: "available-sailings",
        requireSubmitEndpointMatch: true,
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

    // The beacon fired 14 times with a byte-identical URL and body and shares
    // no structural relation to the real chain — before the fix, its own
    // repeats mutually vouched for each other's tokens (its compound path has
    // only one two-word segment, below the "densely name-spaced" carve-out's
    // threshold) and it survived as its own hard-coded call.
    expect(contract).not.toContain("authenticator");
    expect(contract).not.toContain("responder");

    // The genuine chain's real endpoints must still be emitted.
    expect(contract).toContain("available-products");
    expect(contract).toContain("available-sailings");
  }, 30_000);
});
