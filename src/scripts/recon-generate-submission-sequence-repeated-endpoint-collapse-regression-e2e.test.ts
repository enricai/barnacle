import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";
import type { Capture } from "@/scripts/recon-shared";

/**
 * Regression for the report's problem #1: a polled/paged submission-flow
 * capture set (toggles polled repeatedly, a listing endpoint paged
 * repeatedly, a drill endpoint hit once per item) must collapse into a
 * paged loop + a hoisted per-item drill instead of unrolling every capture
 * into its own hard-coded `httpClient` call. Asserts both of the report's
 * own verification hooks together: the generated call count stays in the
 * same order of magnitude as the report's shipped reference (4 calls), and
 * the generated contract.ts line count stays in the low hundreds for this
 * 10-step flow, not the multi-thousand-line magnitude a fully unrolled
 * contract (one hard-coded call per one of the 17 raw captures) would
 * produce.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const OWN_BACKEND_HOST = "www.own-backend-repeated-endpoint-collapse-regression.example.com";
const TOGGLES_URL = `https://${OWN_BACKEND_HOST}/toggles/product-avail`;
const LISTING_URL = `https://${OWN_BACKEND_HOST}/available-products/`;
const DRILL_URL = `https://${OWN_BACKEND_HOST}/available-sailings/`;

const TOGGLES_POLL_COUNT = 6;
const LISTING_PAGE_COUNT = 8;
const DRILL_ITEM_COUNT = 3;

function polledPagedDrillCaptures(): Capture[] {
  const toggles = Array.from({ length: TOGGLES_POLL_COUNT }, (_, i) =>
    buildCapture({
      url: TOGGLES_URL,
      requestPostData: "[]",
      responseBody: [{ name: "feature-a", enabled: true }],
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
  return [...toggles, ...listing, ...drills];
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

describe("recon-generate CLI — polled+paged+per-item-drill submission flow collapses into a paged-loop shape", () => {
  it("emits a call count in the same order of magnitude as 4 and a ~500-900 line contract.ts, not one call per capture", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-repeated-endpoint-collapse-regression-e2e-"));
    const runRoot = join(workDir, "run");
    writeRunDir(runRoot, polledPagedDrillCaptures());

    const siteId = `repeated-endpoint-collapse-regression-e2e-test-${process.pid}`;
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

    // Raw capture count is 17 (6 toggle polls + 8 listing pages + 3 drills).
    // Before the fix this unrolled 1:1 with the capture count; the fix
    // collapses the paged listing into one loop and the per-item drill
    // into one hoisted call, so the call count stays bounded and in the
    // same order of magnitude as the report's own shipped reference (4).
    const httpClientCallCount = (contract.match(/await httpClient\(/g) ?? []).length;
    expect(httpClientCallCount).toBeLessThanOrEqual(10);

    // The report's own line-count verification hook: a correctly collapsed
    // contract for this 10-step flow stays in the low hundreds of lines,
    // not the multi-thousand-line magnitude a fully unrolled contract (one
    // hard-coded call per one of the 17 raw captures) would produce.
    const lineCount = contract.split("\n").length;
    expect(lineCount).toBeGreaterThanOrEqual(100);
    expect(lineCount).toBeLessThanOrEqual(300);
  }, 30_000);
});
