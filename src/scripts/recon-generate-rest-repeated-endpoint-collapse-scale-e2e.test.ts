import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";
import type { Capture } from "@/scripts/recon-shared";

/**
 * At realistic repeat-count scale (6 polled-toggle repeats, 8 paged-listing
 * repeats, 8 per-item drill repeats), the toggles and paged-listing endpoints
 * collapse to a single `httpClient(` call each, but the current collapse/hoist
 * logic does not fold the per-item drill: it hoists exactly one call inside
 * the fold loop and then unrolls one literal call per remaining item, so the
 * drill endpoint contributes DRILL_ITEM_COUNT (8) calls, not 1. This test
 * pins that verified behavior — collapsing the drill fully is a known gap in
 * the generator, not something this test asserts.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const OWN_BACKEND_HOST = "www.own-backend-collapse-scale-fixture.example.com";
const TOGGLES_URL = `https://${OWN_BACKEND_HOST}/toggles/product-avail`;
const LISTING_URL = `https://${OWN_BACKEND_HOST}/available-products/`;
const DRILL_URL = `https://${OWN_BACKEND_HOST}/available-sailings/`;

const TOGGLES_POLL_COUNT = 6;
const LISTING_PAGE_COUNT = 8;
const DRILL_ITEM_COUNT = 8;

function scaledFixtureCaptures(): Capture[] {
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

describe("recon-generate CLI — repeated-endpoint collapse at realistic repeat-count scale", () => {
  it("collapses fully-repeated endpoints and hoists the first drill call, at report-scale repeat counts", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-repeated-endpoint-collapse-scale-e2e-"));
    const runRoot = join(workDir, "run");
    writeRunDir(runRoot, scaledFixtureCaptures());

    const siteId = `repeated-endpoint-collapse-scale-e2e-test-${process.pid}`;
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

    // Raw capture count is 22 (6 toggles + 8 listing pages + 8 drills). The
    // toggles and paged-listing endpoints collapse fully; the drill endpoint
    // hoists one call inside the fold loop and unrolls the rest literally,
    // so the total is 1 + 1 + DRILL_ITEM_COUNT, not the raw 22.
    expect(httpClientCallCount).toBe(2 + DRILL_ITEM_COUNT);

    // Each fully-collapsed endpoint survives exactly once.
    expect(contract.match(/toggles\/product-avail/g)?.length).toBe(1);
    expect(contract.match(/available-products\//g)?.length).toBe(1);

    // Known gap: the drill endpoint does not collapse — it appears once per
    // drill item rather than being hoisted to a single call.
    expect(contract.match(/available-sailings\//g)?.length).toBe(DRILL_ITEM_COUNT);
  }, 30_000);
});
