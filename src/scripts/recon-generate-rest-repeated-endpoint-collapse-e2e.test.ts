import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";
import type { Capture } from "@/scripts/recon-shared";

/**
 * Reproduces the report's exact shape at REST scale: a polled toggles
 * endpoint re-fired identically many times, a paged listing endpoint
 * re-fired across many pages, and a per-item drill fired once per listed
 * item — all captured against one own-backend host, with no `foldReturn`
 * declared (mirroring the report's own flow). Before the fix, every one of
 * these repeated same-endpoint captures survived as its own hard-coded
 * `httpClient` call; the fix collapses the toggles/listing repeats down to
 * one call each, leaving the genuinely distinct per-item drill calls intact.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const OWN_BACKEND_HOST = "www.own-backend-rest-repeated-endpoint-fixture.example.com";
const TOGGLES_URL = `https://${OWN_BACKEND_HOST}/toggles/product-avail`;
const LISTING_URL = `https://${OWN_BACKEND_HOST}/available-products/`;
const DRILL_URL = `https://${OWN_BACKEND_HOST}/available-sailings/`;

const TOGGLES_POLL_COUNT = 6;
const LISTING_PAGE_COUNT = 8;
const DRILL_ITEM_COUNT = 3;

function reportShapeCaptures(): Capture[] {
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
      url: LISTING_URL,
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

describe("recon-generate CLI — REST same-endpoint repeats collapse instead of unrolling one httpClient call per capture", () => {
  it("emits an httpClient call count in the same order of magnitude as the hand-built reference, not one per raw capture", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-rest-repeated-endpoint-collapse-e2e-"));
    const runRoot = join(workDir, "run");
    const captures = reportShapeCaptures();
    writeRunDir(runRoot, captures);

    const siteId = `rest-repeated-endpoint-collapse-e2e-test-${process.pid}`;
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
    const httpClientCallCount = (contract.match(/await httpClient\(/g) ?? []).length;

    // Raw capture count is 17 (6 toggles + 8 listing pages + 3 drills). The
    // report's own verification hook: order of magnitude 4-ish, not one
    // hard-coded call per raw capture.
    expect(httpClientCallCount).toBeLessThan(10);

    // The toggles poll and the listing endpoint each survive exactly once —
    // collapsed from 6 and 8 raw occurrences respectively — regardless of
    // whether the per-item drill below resolves as a fold loop or as
    // individual calls.
    expect(contract.match(/toggles\/product-avail/g)?.length).toBe(1);
    expect(contract.match(/available-products\//g)?.length).toBe(1);
  }, 30_000);

  it("still collapses a paged listing that also carries an incidental cache-buster query param alongside its pagination cursor", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-rest-repeated-endpoint-collapse-noise-e2e-"));
    const runRoot = join(workDir, "run");
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
    writeRunDir(runRoot, [...listing, ...drills]);

    const siteId = `rest-repeated-endpoint-collapse-noise-e2e-test-${process.pid}`;
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
    const httpClientCallCount = (contract.match(/await httpClient\(/g) ?? []).length;

    // Without the cache-buster query key excluded from the varying-key
    // check, this listing group would vary in two fields (page + `_`) and
    // fail to collapse, leaving all 8 pages unrolled as individual calls.
    expect(httpClientCallCount).toBeLessThan(10);
    expect(contract.match(/available-products\//g)?.length).toBe(1);
  }, 30_000);
});
