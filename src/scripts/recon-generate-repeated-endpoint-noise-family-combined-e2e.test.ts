import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";
import type { Capture } from "@/scripts/recon-shared";

/**
 * Combined CLI-level regression for the report's own verification hooks:
 * a polled toggles endpoint, a paged listing endpoint whose repeats also
 * carry an incidental cache-buster query field, a per-item drill, and two
 * same-noise-family marketing-style path variants on the same host must
 * together collapse to an httpClient call count in the same order of
 * magnitude as the report's shipped 4-call reference, with neither noise
 * variant surviving into the emitted contract. bugfix-001
 * (recon-generate-rest-repeated-endpoint-collapse-e2e.test.ts) and
 * bugfix-002 (recon-generate-same-host-noise-path-family-query-variant-guard-e2e.test.ts)
 * each cover one mechanism in isolation; this test proves both fire
 * correctly when exercised together in one fixture.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const OWN_BACKEND_HOST = "www.own-backend-combined-noise-fixture.example.com";
const TOGGLES_URL = `https://${OWN_BACKEND_HOST}/toggles/product-avail`;
const LISTING_URL = `https://${OWN_BACKEND_HOST}/available-products/`;
const DRILL_URL = `https://${OWN_BACKEND_HOST}/available-sailings/`;
const PROMOTIONS_URL = `https://${OWN_BACKEND_HOST}/promotions-spa/banner`;

const TOGGLES_POLL_COUNT = 6;
const LISTING_PAGE_COUNT = 8;
const DRILL_ITEM_COUNT = 3;

function combinedFixtureCaptures(): Capture[] {
  const toggles = Array.from({ length: TOGGLES_POLL_COUNT }, (_, i) =>
    buildCapture({
      url: TOGGLES_URL,
      requestPostData: "[]",
      responseBody: [{ name: "feature-a", enabled: true }],
      timestamp: `2024-01-01T00:00:${String(i).padStart(2, "0")}Z`,
    })
  );

  // Each listing page also carries an incidental cache-buster/nonce query
  // field alongside the real `page` cursor, exercising bugfix-001's
  // varying-key tolerance.
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

  // Two same-noise-family marketing/promotions-style path variants on the
  // same host — sharing the repeated meaningful `promotions-spa/banner`
  // path segment but with two DIFFERENT path/query shapes — exercising
  // bugfix-002's structural-isolation fix (no *Url-suffixed field on
  // either, so the required-URL-field self-heal guard cannot see them).
  const noiseVariantOne = buildCapture({
    url: `${PROMOTIONS_URL}?slot=footer`,
    requestPostData: '{"pageId":"listings"}',
    responseBody: { headline: "Limited-time offer", impressionCount: 1 },
    timestamp: "2024-01-01T00:03:00Z",
  });
  const noiseVariantTwo = buildCapture({
    url: `${PROMOTIONS_URL}/2?slot=header`,
    requestPostData: '{"pageId":"home"}',
    responseBody: { headline: "Seasonal deal", impressionCount: 7 },
    timestamp: "2024-01-01T00:03:01Z",
  });

  return [...toggles, ...listing, ...drills, noiseVariantOne, noiseVariantTwo];
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

describe("recon-generate CLI — combined same-endpoint collapse and noise-family isolation", () => {
  it("emits an order-of-magnitude-correct httpClient call count with no noise-family leakage", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-repeated-endpoint-noise-family-combined-e2e-"));
    const runRoot = join(workDir, "run");
    writeRunDir(runRoot, combinedFixtureCaptures());

    const siteId = `repeated-endpoint-noise-family-combined-e2e-test-${process.pid}`;
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

    // Raw capture count is 19 (6 toggles + 8 listing pages + 3 drills + 2
    // noise variants). The report's own verification hook: order of
    // magnitude 4-ish, not one hard-coded call per raw capture.
    expect(httpClientCallCount).toBeLessThan(10);

    // The toggles poll and the listing endpoint each survive exactly once,
    // collapsed from 6 and 8 raw occurrences respectively.
    expect(contract.match(/toggles\/product-avail/g)?.length).toBe(1);
    expect(contract.match(/available-products\//g)?.length).toBe(1);

    // Neither same-noise-family marketing/promotions path/query variant
    // survives into the emitted contract.
    expect(contract).not.toContain("promotions-spa/banner");
    expect(contract).not.toContain("impressionCount");
  }, 30_000);
});
