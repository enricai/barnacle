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
  // Measured directly against this repo (not assumed): at 1600 chained
  // beacon calls, the hoisted `allCaptures` reference (recon-generate.ts:6703)
  // completes in ~2.6-3.0s on this hardware, since `captureEndpointIndexFor`'s
  // WeakMap-cached index is built once and reused. Reverting to a fresh
  // `actions.map((a) => a.capture)` per Pass-1 iteration — forcing the same
  // index rebuild 1600 times — measured ~8.4-8.9s for the identical input on
  // the same hardware, a ~3x constant-factor gap driven purely by the rebuild
  // count (other Pass-1 work is shared between both shapes and scales
  // identically either way, so this bound targets that specific gap rather
  // than overall algorithmic order). 6000ms sits below every observed
  // pre-fix sample and above every observed post-fix sample with headroom on
  // both sides.
  it("emits a large chained-beacon flow within a bound only the hoisted reference can meet", () => {
    const actions = buildLargeBeaconActionSequence(1600);

    const start = performance.now();
    emit(actions);
    const elapsedMs = performance.now() - start;

    expect(elapsedMs).toBeLessThan(6000);
  });
});
