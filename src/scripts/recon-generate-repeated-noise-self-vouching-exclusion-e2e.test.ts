import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";
import type { Capture } from "@/scripts/recon-shared";

/**
 * Regression for the generalized failure mode behind #bugfix-003: a same-
 * host, fixed-query, structurally self-contained noise endpoint fired many
 * times through the full CLI pipeline must be excluded by the generic
 * structural-isolation gate in `extractActionSequence`, purely because it
 * shares no structural relation to the rest of the pool — not because of any
 * per-site pattern. Before the fix, the gate excluded only the exact array
 * index of the candidate from its own comparison set, so N identical
 * repeats of the noise endpoint trivially satisfied each other's
 * token-overlap check and none was ever recognized as isolated.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const OWN_BACKEND_HOST = "www.own-backend-repeated-noise-self-vouching-exclusion.example.com";
const NOISE_URL = `https://${OWN_BACKEND_HOST}/site-banner/promotions-widget?slot=header`;
const TOGGLES_URL = `https://${OWN_BACKEND_HOST}/toggles/product-avail`;
const LISTING_URL = `https://${OWN_BACKEND_HOST}/available-products/`;
const DRILL_URL = `https://${OWN_BACKEND_HOST}/available-sailings/`;

const NOISE_FIRE_COUNT = 12;
const TOGGLES_POLL_COUNT = 6;
const LISTING_PAGE_COUNT = 8;
const DRILL_ITEM_COUNT = 3;

function selfVouchingNoiseAlongsideRealChainCaptures(): Capture[] {
  const noise = Array.from({ length: NOISE_FIRE_COUNT }, (_, i) =>
    buildCapture({
      url: NOISE_URL,
      requestPostData: "{}",
      responseBody: { ok: true },
      timestamp: `2024-01-01T00:00:${String(i).padStart(2, "0")}Z`,
    })
  );
  const toggles = Array.from({ length: TOGGLES_POLL_COUNT }, (_, i) =>
    buildCapture({
      url: TOGGLES_URL,
      requestPostData: "[]",
      responseBody: [{ name: "feature-a", enabled: true }],
      timestamp: `2024-01-01T00:01:${String(i).padStart(2, "0")}Z`,
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
      timestamp: `2024-01-01T00:02:${String(i).padStart(2, "0")}Z`,
    })
  );
  const drills = Array.from({ length: DRILL_ITEM_COUNT }, (_, i) =>
    buildCapture({
      url: DRILL_URL,
      requestPostData: JSON.stringify({ productId: `p${i + 1}` }),
      responseBody: { units: [{ unitId: `s${i + 1}` }], exchangeRate: 1.0 },
      timestamp: `2024-01-01T00:03:${String(i).padStart(2, "0")}Z`,
    })
  );
  return [...noise, ...toggles, ...listing, ...drills];
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

describe("recon-generate CLI — repeated self-vouching noise endpoint is excluded from the resolved pool", () => {
  it("emits the genuine chain's real endpoints while never referencing the same-host noise endpoint's URL", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-repeated-noise-self-vouching-exclusion-e2e-"));
    const runRoot = join(workDir, "run");
    writeRunDir(runRoot, selfVouchingNoiseAlongsideRealChainCaptures());

    const siteId = `repeated-noise-self-vouching-exclusion-e2e-test-${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    mkdirSync(siteOutDir, { recursive: true });
    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({
        steps: [
          { step: "poll feature toggles" },
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

    // The noise endpoint fired 12 times with a fixed, self-contained
    // compound path and shares no structural relation to the real chain —
    // before the fix, its repeats mutually vouched for each other and it
    // survived as its own hard-coded call.
    expect(contract).not.toContain("site-banner");
    expect(contract).not.toContain("promotions-widget");

    // The genuine chain's real endpoints must still be emitted.
    expect(contract).toContain("available-products");
    expect(contract).toContain("available-sailings");
  }, 30_000);
});
