import { afterEach, describe, expect, it, vi } from "vitest";
import * as captureFilters from "@/recon/capture-filters";
import { emitMultiStepExecuteHttp } from "@/scripts/recon-generate";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";

/**
 * The Pass 1 render loop in `emitMultiStepExecuteHttp` hoists
 * `actions.map((a) => a.capture)` out of the per-step loop so every call to
 * `isZeroVarianceRepeatCapture` shares one array reference. This proves that
 * identity is actually stable across steps, not just deep-equal, so a future
 * edit that reintroduces the inline `.map()` inside the loop is caught
 * mechanically.
 */

const BASE = "https://api.example.com";

// Response bodies deliberately carry no multi-item array — a fold-eligible
// shape would trigger the SEPARATE per-fold-target hoist (recon-generate.ts
// ~L7218), which has its own `allCaptures` array and is out of scope for
// this assertion; this fixture isolates the Pass 1 render loop's own hoist.
function buildChainActions(): [unknown, unknown, unknown] {
  const search = {
    capture: buildCapture({
      url: `${BASE}/catalog/search/`,
      requestPostData: '{"page":1}',
      responseBody: { note: "ok" },
      timestamp: "2026-01-01T00:00:01Z",
    }),
    varName: "r1",
    produces: [],
    isMultipart: false,
    isCrossDomain: false,
  };
  const drill = {
    capture: buildCapture({
      url: `${BASE}/beacon/item-a/verify?clientId=abc123&siteId=xyz&nonce=1`,
      requestPostData: null,
      method: "GET",
      responseBody: {},
      timestamp: "2026-01-01T00:00:02Z",
    }),
    varName: "r2",
    produces: [],
    isMultipart: false,
    isCrossDomain: false,
  };
  const beaconRepeat = {
    capture: buildCapture({
      url: `${BASE}/beacon/item-a/verify?clientId=abc123&siteId=xyz&nonce=2`,
      requestPostData: null,
      method: "GET",
      responseBody: {},
      timestamp: "2026-01-01T00:00:03Z",
    }),
    varName: "r3",
    produces: [],
    isMultipart: false,
    isCrossDomain: false,
  };
  return [search, drill, beaconRepeat];
}

describe("Pass 1 render loop — allCaptures array reference stability", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("passes the SAME allCaptures array reference to isZeroVarianceRepeatCapture across every Pass 1 call", () => {
    const spy = vi.spyOn(captureFilters, "isZeroVarianceRepeatCapture");
    const [search, drill, beaconRepeat] = buildChainActions();

    emitMultiStepExecuteHttp(
      [search, drill, beaconRepeat] as unknown as Parameters<typeof emitMultiStepExecuteHttp>[0],
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

    expect(spy.mock.calls.length).toBeGreaterThan(0);

    const allCapturesArgs = spy.mock.calls.map(([, allCaptures]) => allCaptures);
    const [first, ...rest] = allCapturesArgs;
    for (const arg of rest) {
      expect(arg).toBe(first);
    }
  });
});
