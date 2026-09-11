import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";
import type { Capture } from "@/scripts/recon-shared";

/**
 * Regression for the report's problem #1, against the one dimension no
 * existing fixture exercises: raw capture ORDER interleaved across three
 * repeating endpoint types (a polled toggles endpoint, a paged listing
 * endpoint, a per-item drill endpoint) plus a one-off auth-style capture,
 * rather than grouped by endpoint. The report's own WARN-line trace shows
 * captures arriving in exactly this interleaved shape (toggles -> one-off ->
 * listing -> drill -> listing -> drill -> ... -> toggles repeated ~6x), not
 * grouped by endpoint the way every other fixture in this repo builds them.
 * The collapse (paged loop + hoisted per-item drill) must be a property of
 * the capture SET, independent of the order those captures were recorded in.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const OWN_BACKEND_HOST =
  "www.own-backend-interleaved-multiendpoint-collapse-regression.example.com";
const TOGGLES_URL = `https://${OWN_BACKEND_HOST}/toggles/feature-flags`;
const SESSION_TOKEN_URL = `https://${OWN_BACKEND_HOST}/auth/session-token`;
const LISTING_URL = `https://${OWN_BACKEND_HOST}/listings/available-products/`;
const DRILL_URL = `https://${OWN_BACKEND_HOST}/listings/available-units/`;

const TOGGLES_POLL_COUNT = 6;
const LISTING_PAGE_COUNT = 8;
const DRILL_ITEM_COUNT = 7;

function toggleCapture(pollIndex: number, secondsOffset: number): Capture {
  return buildCapture({
    url: TOGGLES_URL,
    requestPostData: "[]",
    responseBody: [{ name: "feature-a", enabled: pollIndex % 2 === 0 }],
    timestamp: `2024-01-01T00:00:${String(secondsOffset).padStart(2, "0")}Z`,
  });
}

function listingCapture(page: number, secondsOffset: number): Capture {
  return buildCapture({
    url: `${LISTING_URL}?_=${1700000000 + page}`,
    requestPostData: JSON.stringify({ page: page + 1 }),
    responseBody: {
      totalPages: LISTING_PAGE_COUNT,
      totalAvailableListings: LISTING_PAGE_COUNT * 2,
      products: [{ productId: `p${page + 1}` }],
    },
    timestamp: `2024-01-01T00:00:${String(secondsOffset).padStart(2, "0")}Z`,
  });
}

function drillCapture(item: number, secondsOffset: number): Capture {
  return buildCapture({
    url: DRILL_URL,
    requestPostData: JSON.stringify({ productId: `p${item + 1}` }),
    responseBody: { units: [{ unitId: `u${item + 1}` }], exchangeRate: 1.0 },
    timestamp: `2024-01-01T00:00:${String(secondsOffset).padStart(2, "0")}Z`,
  });
}

/**
 * Builds captures manually in the report's literal interleaved order
 * (poll, one-off, page-1, drill-1, poll, page-2, drill-2, ...) rather than
 * reusing `buildManyRepeatPagedListingDrillWithNoiseVariantActionSteps`,
 * which emits strictly endpoint-grouped order and so never exercises this
 * defect dimension.
 */
function interleavedCaptures(): Capture[] {
  let t = 0;
  const next = (): number => t++;

  return [
    toggleCapture(0, next()),
    buildCapture({
      url: SESSION_TOKEN_URL,
      requestPostData: "{}",
      responseBody: { result: "anonymous", successful: true },
      timestamp: `2024-01-01T00:00:${String(next()).padStart(2, "0")}Z`,
    }),
    listingCapture(0, next()),
    drillCapture(0, next()),
    toggleCapture(1, next()),
    listingCapture(1, next()),
    drillCapture(1, next()),
    toggleCapture(2, next()),
    listingCapture(2, next()),
    drillCapture(2, next()),
    toggleCapture(3, next()),
    listingCapture(3, next()),
    drillCapture(3, next()),
    toggleCapture(4, next()),
    listingCapture(4, next()),
    drillCapture(4, next()),
    toggleCapture(5, next()),
    listingCapture(5, next()),
    drillCapture(5, next()),
    listingCapture(6, next()),
    drillCapture(6, next()),
    listingCapture(7, next()),
  ];
}

function countByUrl(captures: Capture[], url: string): number {
  return captures.filter((capture) => capture.url.startsWith(url)).length;
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

describe("recon-generate CLI — interleaved multi-endpoint capture order still collapses into a paged-loop shape", () => {
  it("emits a call count in the same order of magnitude as 4 regardless of capture interleaving", () => {
    const captures = interleavedCaptures();

    // Sanity-check the fixture itself actually interleaves rather than
    // grouping by endpoint, and matches the report's own counts.
    expect(countByUrl(captures, TOGGLES_URL)).toBe(TOGGLES_POLL_COUNT);
    expect(countByUrl(captures, SESSION_TOKEN_URL)).toBe(1);
    expect(countByUrl(captures, LISTING_URL)).toBe(LISTING_PAGE_COUNT);
    expect(countByUrl(captures, DRILL_URL)).toBe(DRILL_ITEM_COUNT);
    expect(captures[0]?.url).toBe(TOGGLES_URL);
    expect(captures[1]?.url).toBe(SESSION_TOKEN_URL);
    expect(captures[2]?.url.startsWith(LISTING_URL)).toBe(true);
    expect(captures[3]?.url).toBe(DRILL_URL);

    workDir = mkdtempSync(
      join(tmpdir(), "barnacle-interleaved-multiendpoint-collapse-regression-e2e-")
    );
    const runRoot = join(workDir, "run");
    writeRunDir(runRoot, captures);

    const siteId = `interleaved-multiendpoint-collapse-regression-e2e-test-${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    mkdirSync(siteOutDir, { recursive: true });
    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({
        steps: [
          { step: "poll feature toggles" },
          { step: "mint anonymous session token" },
          { step: "browse paged listing" },
          { step: "drill into item detail", submitStep: true },
        ],
        submitEndpointPattern: "available-units",
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

    // Raw capture count is 22 (6 toggle polls + 1 one-off mint + 8 listing
    // pages + 7 drills), recorded in interleaved capture order. Before the
    // fix this unrolled 1:1 with the capture count regardless of order; the
    // fix collapses the paged listing into one loop and the per-item drill
    // into one hoisted call, so the bound stays small independent of both
    // the repeat counts AND the order captures were recorded in.
    const httpClientCallCount = (contract.match(/await httpClient\(/g) ?? []).length;
    expect(httpClientCallCount).toBeLessThanOrEqual(10);
  }, 30_000);
});
