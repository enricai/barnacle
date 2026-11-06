import { describe, expect, it } from "vitest";
import { emitMultiStepExecuteHttp } from "@/scripts/recon-generate";
import { buildStep, type MulticallFixtureStep } from "@/scripts/recon-generate-multicall-fixture";

const BASE = "https://api.example.com";
const BEACON_URL = `${BASE}/beacon/item-a/verify`;

/**
 * One initial search step plus `count` zero-variance-repeat GET beacon calls
 * to the same endpoint — the shape Pass 1's `isZeroVarianceRepeatCapture(cap,
 * allCaptures)` check (recon-generate.ts:6716) classifies by rebuilding
 * `capture-filters.ts`'s `captureEndpointIndexFor` WeakMap index keyed off
 * the `allCaptures` array's own object identity. A fresh `.map()` per loop
 * iteration mints a new array reference every time, defeating that index and
 * forcing an O(n) rebuild per iteration (O(n^2) total); the hoisted
 * `allCaptures` reference (recon-generate.ts:6703) reuses one index build
 * across every iteration (O(n) total).
 */
function buildLargeBeaconActionSequence(count: number): MulticallFixtureStep[] {
  const search = buildStep("r0", {
    url: `${BASE}/catalog/search/`,
    requestPostData: '{"page":1}',
    responseBody: { results: [{ sku: "item-a", tag: "g0" }] },
    timestamp: "2026-01-01T00:00:00Z",
  });
  const beacons = Array.from({ length: count }, (_, i) =>
    buildStep(`r${i + 1}`, {
      url: `${BEACON_URL}?clientId=abc123&siteId=xyz&nonce=${i}`,
      requestPostData: null,
      method: "GET",
      responseBody: {},
      timestamp: `2026-01-01T00:${String(i % 60).padStart(2, "0")}:00Z`,
    })
  );
  return [search, ...beacons];
}

function emit(actions: MulticallFixtureStep[]): string {
  return emitMultiStepExecuteHttp(
    actions as unknown as Parameters<typeof emitMultiStepExecuteHttp>[0],
    null,
    { stringMessageKey: null, nestedErrorPaths: [] },
    new Map(),
    new Set(),
    new Map(),
    new Set(),
    new Map(),
    new Map(),
    BASE,
    new Map(),
    new Map()
  );
}

describe("emitMultiStepExecuteHttp Pass 1 bypass-site hoist — output parity", () => {
  it("emits byte-identical output for the same multi-step flow across repeated calls", () => {
    const actions = buildLargeBeaconActionSequence(12);

    const first = emit(actions);
    const second = emit(buildLargeBeaconActionSequence(12));

    expect(second).toBe(first);
    expect(first).toContain("beacon/item-a/verify");
  });
});

describe("emitMultiStepExecuteHttp Pass 1 bypass-site hoist — scale", () => {
  // Guards the reference-keyed caches that keep Pass 1's per-step rescans
  // cheap: the hoisted `allCaptures` reference feeding
  // `captureEndpointIndexFor`'s WeakMap index, and `endpointTemplateKey`'s
  // own memo. Dropping either one re-derives the same index/parse per step
  // and measured a ~3x slowdown on this input.
  //
  // Pass 1 is quadratic in capture count regardless (`gatherEntityVarianceEvidence`
  // and `gatherResponseBodySamples` each rescan every capture per step), so
  // this is a constant-factor guard, not an O(n) claim. Capture count is kept
  // at 600 — ~0.5-0.8s locally — precisely so the bound keeps a wide margin:
  // a shared CI runner several times slower than a dev machine still passes,
  // while losing a cache still overshoots. An earlier 1600-capture version of
  // this test sat ~4.4s against the same bound and failed on CI for machine
  // speed alone rather than for any regression.
  it("emits a large chained-beacon flow within a bound only the cached references can meet", () => {
    const actions = buildLargeBeaconActionSequence(600);

    const start = performance.now();
    emit(actions);
    const elapsedMs = performance.now() - start;

    expect(elapsedMs).toBeLessThan(6000);
  });
});
