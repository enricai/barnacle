import { afterEach, describe, expect, it } from "vitest";

import { isZeroVarianceRepeatCapture } from "@/recon/capture-filters";

/**
 * Proves the shared-index rewrite in capture-filters.ts (WeakMap-cached
 * `captureEndpointIndexFor`) is behavior-preserving and actually stops the
 * per-candidate full-array rescan the original report measured on a
 * ~4700-capture archive: same verdicts as the pre-rewrite linear scan across
 * a large synthetic capture set, and `new URL()` construction (the cost the
 * index replaced) no longer grows per candidate once an archive's index has
 * been built.
 */

type Capture = {
  method: string;
  url: string;
  requestPostData: string | null;
  responseHeaders?: Record<string, string>;
  responseBody?: unknown;
  operationName?: string | null;
  query?: string | null;
};

const originalURL = globalThis.URL;

afterEach(() => {
  globalThis.URL = originalURL;
});

function spyOnURLConstructor(): { count: () => number } {
  let calls = 0;
  class CountingURL extends originalURL {
    constructor(...args: ConstructorParameters<typeof originalURL>) {
      super(...args);
      calls += 1;
    }
  }
  globalThis.URL = CountingURL as unknown as typeof URL;
  return { count: () => calls };
}

/**
 * Deterministic, dense filler traffic spanning many endpoints/methods/
 * pathnames — the shape the report's ~4700-capture archive had. Includes
 * a handful of unparsable-URL entries to exercise the index build's
 * preserved try/catch paths.
 */
function buildLargeSyntheticCaptureSet(count: number): Capture[] {
  return Array.from({ length: count }, (_, i) => {
    if (i % 137 === 0) {
      return {
        method: "GET",
        url: "not a valid url ::",
        requestPostData: null,
      };
    }
    const endpointIndex = i % 40;
    return {
      method: i % 5 === 0 ? "POST" : "GET",
      url: `https://api.example.com/catalog/endpoint-${endpointIndex}/item-${i}?clientId=vendor-${endpointIndex}&nonce=${i}`,
      requestPostData: i % 5 === 0 ? `{"page":${i}}` : null,
      responseHeaders: { "content-type": "application/json" },
      responseBody: { viewCount: i, itemId: `item-${i}` },
    };
  });
}

/**
 * Hand-computed reference candidates mirroring the fixed-query-beacon shape
 * already covered by capture-filters.test.ts, dropped into the large
 * synthetic set so the same verdicts must hold at scale.
 */
function referenceCandidatesWithExpectations(): {
  candidate: Capture;
  sibling: Capture;
  expected: boolean;
}[] {
  const beaconUrl = "https://apply.acme.example/auth/responder.html?clientId=X&environment=PROD";
  const beaconFirst: Capture = { method: "GET", url: beaconUrl, requestPostData: null };
  const beaconSecond: Capture = { method: "GET", url: beaconUrl, requestPostData: null };

  const realEndpointUrl = "https://apply.acme.example/api/v1/availability?productId=abc";
  const realFirst: Capture = {
    method: "GET",
    url: realEndpointUrl,
    requestPostData: null,
    responseHeaders: { "content-type": "application/json" },
    responseBody: { enabled: true, variant: "control" },
  };
  const realSecond: Capture = {
    method: "GET",
    url: "https://apply.acme.example/api/v1/availability?productId=def",
    requestPostData: null,
    responseHeaders: { "content-type": "application/json" },
    responseBody: { enabled: false, variant: "control" },
  };

  return [
    { candidate: beaconFirst, sibling: beaconSecond, expected: true },
    { candidate: realFirst, sibling: realSecond, expected: false },
  ];
}

describe("captureEndpointIndexCache — equivalence with the pre-rewrite linear scan", () => {
  it("returns identical verdicts for a representative synthetic set of >500 captures spanning many endpoints/methods/pathnames, including unparsable-URL entries", () => {
    const largeSet = buildLargeSyntheticCaptureSet(600);

    largeSet.forEach((candidate, i) => {
      const isUnparsable = i % 137 === 0;
      const verdict = isZeroVarianceRepeatCapture(candidate, largeSet);
      if (isUnparsable) {
        expect(verdict).toBe(false);
        return;
      }
      // Each endpoint-index bucket shares the same fixed clientId query key
      // and a nonce that varies per capture, with a JSON response carrying
      // a distinct viewCount/itemId per occurrence (real, non-echoed data) —
      // this must never be flagged noise regardless of bucket size.
      expect(verdict).toBe(false);
    });
  });

  it("matches capture-filters.test.ts's own hand-computed fixed-query-beacon and real-endpoint verdicts when embedded in a large synthetic array", () => {
    const filler = buildLargeSyntheticCaptureSet(520);
    const cases = referenceCandidatesWithExpectations();

    for (const { candidate, sibling, expected } of cases) {
      const allCaptures = [candidate, sibling, ...filler];
      expect(isZeroVarianceRepeatCapture(candidate, allCaptures)).toBe(expected);
    }
  });

  it("does not re-scan the full array (new URL() construction) per candidate once the index for a given array reference is built", () => {
    const largeSet = buildLargeSyntheticCaptureSet(800);
    const urlSpy = spyOnURLConstructor();

    isZeroVarianceRepeatCapture(largeSet[1]!, largeSet);
    const callsAfterFirstLookup = urlSpy.count();
    // Building the index parses every capture's URL at most twice
    // (endpointOrigin + pathname parse), so the very first lookup against a
    // fresh array reference is expected to cost close to O(n).
    expect(callsAfterFirstLookup).toBeGreaterThan(largeSet.length);

    const candidatesToProbe = largeSet.slice(2, 102);
    for (const candidate of candidatesToProbe) {
      isZeroVarianceRepeatCapture(candidate, largeSet);
    }
    const callsAfterHundredMoreLookups = urlSpy.count() - callsAfterFirstLookup;

    // If every subsequent lookup re-scanned/re-parsed the whole array, 100
    // more candidates against an 800-capture array would cost at least
    // 100 * 800 = 80,000 additional URL() constructions. The index reuse
    // this subtask proves should cost at most a small constant per
    // candidate (parsing the candidate's own URL and, for a query-bearing
    // candidate, its same-endpoint siblings) — nowhere near the full array
    // size per call.
    expect(callsAfterHundredMoreLookups).toBeLessThan(largeSet.length);
  });

  it("reuses the same index across many candidates without accumulating per-candidate full-array cost as more lookups happen", () => {
    const largeSet = buildLargeSyntheticCaptureSet(1000);
    const urlSpy = spyOnURLConstructor();

    // Prime the index.
    isZeroVarianceRepeatCapture(largeSet[0]!, largeSet);
    const afterPriming = urlSpy.count();

    const firstBatchCandidates = largeSet.slice(1, 51);
    for (const candidate of firstBatchCandidates) isZeroVarianceRepeatCapture(candidate, largeSet);
    const afterFirstBatch = urlSpy.count() - afterPriming;

    const secondBatchCandidates = largeSet.slice(51, 101);
    for (const candidate of secondBatchCandidates) isZeroVarianceRepeatCapture(candidate, largeSet);
    const afterSecondBatch = urlSpy.count() - afterPriming - afterFirstBatch;

    // Per-candidate cost for an equal-sized later batch should not have
    // grown relative to the first batch — proof there is no accumulating
    // full re-scan as more of the same array is probed.
    expect(afterSecondBatch).toBeLessThanOrEqual(afterFirstBatch * 2 + 50);
    // Average per-candidate cost stays a small fraction of the array size
    // (bounded by same-endpoint bucket size, not the whole archive) — a full
    // per-candidate rescan would cost ~largeSet.length URL() calls EACH,
    // i.e. ~50 * 1000 = 50,000 for this batch alone.
    expect(afterFirstBatch / firstBatchCandidates.length).toBeLessThan(largeSet.length / 4);
  });
});
