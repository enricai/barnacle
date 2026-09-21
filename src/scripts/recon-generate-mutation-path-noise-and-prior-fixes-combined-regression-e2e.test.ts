import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isZeroVarianceRepeatCapture } from "@/recon/capture-filters";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";
import type { Capture } from "@/scripts/recon-shared";

/**
 * Combined acceptance test proving this task's mutation-path
 * structural-relevance fix coexists, on one fixture, with the three prior
 * fixes to the same downstream symptom (no fold plan resolved):
 * `isZeroVarianceRepeatCapture`'s low-occurrence exclusion, the
 * production-scale noise-admission fix, and `primaryIdentityAnchor`
 * order-independence in `resolveFoldPlan`. Each condition below is built so
 * it would, on its own, have starved the real search+drill fold plan under
 * at least one of the four pre-fix behaviors:
 *
 * - a GraphQL search primary is captured twice under the identical
 *   operation identity: first as a trivial, noise-shaped (empty-results)
 *   occurrence, then later as the real occurrence — exercises
 *   `primaryIdentityAnchor` order-independence (the fold plan must resolve
 *   off the emitted-primary identity, not first-array-order).
 * - a same-origin, queryless-repeat noise family sits just BELOW
 *   `MIN_QUERYLESS_REPEAT_COUNT` (2 occurrences) alongside one just ABOVE it
 *   (12 occurrences) — exercises `isZeroVarianceRepeatCapture`'s
 *   low-occurrence exclusion boundary.
 * - a high-volume mixed-family noise set (third-party ad-tech/telemetry
 *   hosts plus a second same-origin queryless widget family) outnumbers the
 *   real captures at production scale — exercises the noise-admission
 *   regression fix.
 * - 15 same-origin, no-query POST beacon/analytics captures populate
 *   `mutationPaths` by HTTP method alone — exercises this task's own fix:
 *   structural-relevance narrowing must not anchor on REST-verb noise and
 *   exclude the genuine read-only search+drill flow.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const OWN_BACKEND_HOST = "www.combined-mutation-noise-fixture.example.com";
const SEARCH_URL = `https://${OWN_BACKEND_HOST}/graphql`;
const DRILL_URL = `https://${OWN_BACKEND_HOST}/catalog/api/v1/details`;
const SEARCH_QUERY =
  "query catalogSearch($filter: String) { catalogSearch(filter: $filter) { items { id title } } }";

function searchCapture(
  filter: string,
  items: Array<{ id: string; title: string }>,
  timestamp: string
): Capture {
  return {
    timestamp,
    phase: "browse",
    method: "POST",
    url: SEARCH_URL,
    status: 200,
    requestHeaders: { "Content-Type": "application/json" },
    requestPostData: JSON.stringify({ query: SEARCH_QUERY, variables: { filter } }),
    responseHeaders: { "content-type": "application/json" },
    responseBody: { catalogSearch: { items } },
    operationName: "catalogSearch",
    query: SEARCH_QUERY,
    variables: { filter },
    decodedParams: null,
  };
}

function drillCapture(itemId: string, timestamp: string): Capture {
  return {
    timestamp,
    phase: "browse",
    method: "GET",
    url: `${DRILL_URL}?id=${itemId}`,
    status: 200,
    requestHeaders: {},
    requestPostData: null,
    responseHeaders: { "content-type": "application/json" },
    responseBody: { detail: [{ id: itemId, region: "region-A" }] },
    operationName: null,
    query: null,
    variables: null,
    decodedParams: null,
  };
}

/** Same-origin no-query POST beacon/analytics capture — an opaque
 * structurally-unrelated path, no GraphQL document, the shape this task's
 * fix must keep out of `mutationPaths`-anchored structural-relevance
 * narrowing. */
function beaconCapture(index: number, timestamp: string): Capture {
  return buildCapture({
    url: `https://${OWN_BACKEND_HOST}/eP8-${String(index).padStart(2, "0")}`,
    requestPostData: JSON.stringify({ evt: "hb", seq: index }),
    responseBody: { ok: true },
    timestamp,
  });
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

function runGenerate(siteId: string, runRoot: string): ReturnType<typeof spawnSync> {
  return spawnSync(
    TSX_BIN,
    [GENERATE_SCRIPT, "--site-id", siteId, "--run-dir", runRoot, "--emit", "ts", "--force"],
    { cwd: REPO_ROOT, encoding: "utf8" }
  );
}

let workDir: string | null = null;
let siteOutDir: string | null = null;

afterEach(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
  if (siteOutDir) rmSync(siteOutDir, { recursive: true, force: true });
  workDir = null;
  siteOutDir = null;
});

describe("recon-generate CLI — mutation-path noise fix alongside prior fold-plan-starvation fixes", () => {
  it("resolves a single correct fold plan with order-swapped duplicate primary, low/high-occurrence noise, and mutation-path beacon noise present together", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-mutation-path-combined-regression-"));
    const runRoot = join(workDir, "run");

    // (a) The real search primary re-issued under the identical operation
    // identity: first a trivial, noise-shaped empty-results occurrence,
    // then later the genuine occurrence with real items.
    const searchNoiseShaped = searchCapture("home", [], "2026-01-01T00:00:00Z");
    const searchReal = searchCapture(
      "outdoor",
      [
        { id: "item-outdoor-1", title: "Item 1" },
        { id: "item-outdoor-2", title: "Item 2" },
      ],
      "2026-01-01T00:00:01Z"
    );
    const drill = drillCapture("item-outdoor-1", "2026-01-01T00:00:02Z");

    let secondsCursor = 3;
    const nextTimestamp = (): string =>
      `2026-01-01T00:00:${String(secondsCursor++).padStart(2, "0")}Z`;

    // (b) A same-origin queryless-repeat noise family just BELOW
    // MIN_QUERYLESS_REPEAT_COUNT (2 occurrences — must NOT be classified
    // noise) alongside one just ABOVE it (12 occurrences — must be).
    const BELOW_THRESHOLD_URL = `https://${OWN_BACKEND_HOST}/pulse/recent-view`;
    const belowThresholdNoise: Capture[] = Array.from({ length: 2 }, (_, i) =>
      buildCapture({
        url: BELOW_THRESHOLD_URL,
        requestPostData: null,
        responseBody: { impressionId: `below-${i}-${Math.random()}` },
        timestamp: nextTimestamp(),
      })
    );
    const ABOVE_THRESHOLD_URL = `https://${OWN_BACKEND_HOST}/pulse/urgency-widget`;
    const aboveThresholdNoise: Capture[] = Array.from({ length: 12 }, (_, i) =>
      buildCapture({
        url: ABOVE_THRESHOLD_URL,
        requestPostData: null,
        responseBody: { impressionId: `above-${i}-${Math.random()}` },
        timestamp: nextTimestamp(),
      })
    );

    // (c) A high-volume mixed-family noise set: third-party ad-tech/
    // telemetry hosts already matched by `isNoiseUrl`, at production scale.
    const THIRD_PARTY_NOISE_URLS = [
      "https://sync.adsrvr.org/beacon?id=1",
      "https://www.googletagmanager.com/gtm.js?id=GTM-XXXX",
      "https://stats.g.doubleclick.net/pixel",
      "https://connect.facebook.net/en_US/fbevents.js",
      "https://static.hotjar.com/c/hotjar.js",
    ];
    const thirdPartyNoise: Capture[] = Array.from({ length: 20 }, (_, i) =>
      buildCapture({
        url: THIRD_PARTY_NOISE_URLS[i % THIRD_PARTY_NOISE_URLS.length]!,
        requestPostData: null,
        responseBody: { ok: true },
        timestamp: nextTimestamp(),
      })
    );

    // (d) 15 same-origin, no-query POST beacon captures — this task's own
    // fix: must not anchor `mutationPaths`-based structural-relevance
    // narrowing and exclude the genuine read-only search+drill flow.
    const beaconNoise: Capture[] = Array.from({ length: 15 }, (_, i) =>
      beaconCapture(i, nextTimestamp())
    );

    const allCaptures = [
      searchNoiseShaped,
      searchReal,
      drill,
      ...belowThresholdNoise,
      ...aboveThresholdNoise,
      ...thirdPartyNoise,
      ...beaconNoise,
    ];

    // Pin the low/high-occurrence boundary directly, as this repo's own
    // combined-regression tests do for each mechanism they exercise.
    expect(isZeroVarianceRepeatCapture(belowThresholdNoise[0]!, allCaptures)).toBe(false);
    expect(isZeroVarianceRepeatCapture(aboveThresholdNoise[0]!, allCaptures)).toBe(true);

    writeRunDir(runRoot, allCaptures);

    const siteId = `mutation-path-noise-combined-regression-test-${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    mkdirSync(siteOutDir, { recursive: true });
    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({
        steps: [{ step: "search the catalog" }],
        ownBackendHostnames: [OWN_BACKEND_HOST],
        foldReturn: {
          endpointPattern: "/catalog/api/v1/details",
          resultsPath: "catalogSearch.items",
          drillResultsPath: "detail",
          joinFields: ["id"],
        },
      })
    );

    const result = runGenerate(siteId, runRoot);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).not.toContain("no fold plan resolved");

    const contract = readFileSync(join(siteOutDir, "contract.ts"), "utf8");

    // The real primary/drill fields survive intact.
    expect(contract).toContain("title");
    expect(contract).toContain("region");

    // Every noise endpoint string is omitted.
    expect(contract).not.toContain("pulse/recent-view");
    expect(contract).not.toContain("pulse/urgency-widget");
    expect(contract).not.toContain("adsrvr.org");
    expect(contract).not.toContain("googletagmanager.com");
    expect(contract).not.toContain("doubleclick.net");
    expect(contract).not.toContain("facebook.net");
    expect(contract).not.toContain("hotjar.com");
    expect(contract).not.toContain("eP8-");
  }, 30_000);
});
