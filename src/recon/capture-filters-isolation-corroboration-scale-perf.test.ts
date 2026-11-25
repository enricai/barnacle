import { describe, expect, it } from "vitest";

import { isZeroVarianceRepeatCapture } from "@/recon/capture-filters";

/**
 * Below {@link MIN_DENSE_REPEAT_FOR_RESPONSE_VARIANCE_SIGNAL} (10, not
 * exported) so every candidate below falls into the structural-isolation
 * corroboration branch — the only branch that reaches `otherEndpointPaths`,
 * `nonNoiseOtherEndpointPaths`, and `poolPathLooksNoiseShaped`.
 */
const OCCURRENCES_PER_CANDIDATE = 5;
const CANDIDATE_COUNT = 150;

type Capture = {
  method: string;
  url: string;
  requestPostData: string | null;
  responseHeaders?: Record<string, string>;
  responseBody?: unknown;
  operationName?: string | null;
  query?: string | null;
};

function buildQuerylessCorroborationPool(candidateCount: number, occurrencesPerCandidate: number) {
  const allCaptures: Capture[] = [];
  for (let i = 0; i < candidateCount; i++) {
    const path = `/api/resource-${i}/detail`;
    for (let occurrence = 0; occurrence < occurrencesPerCandidate; occurrence++) {
      allCaptures.push({
        method: "GET",
        url: `https://example.test${path}`,
        requestPostData: null,
        responseHeaders: { "content-type": "application/json" },
        responseBody: { payload: `stable-value-${i}` },
        operationName: null,
        query: null,
      });
    }
  }
  return allCaptures;
}

describe("isZeroVarianceRepeatCapture — queryless isolation-corroboration branch stays near-linear at scale", () => {
  it("evaluates hundreds of low-occurrence queryless candidates against hundreds of distinct pool paths well under a fixed wall-clock bound", () => {
    const allCaptures = buildQuerylessCorroborationPool(CANDIDATE_COUNT, OCCURRENCES_PER_CANDIDATE);
    const candidates = allCaptures.filter((_, index) => index % OCCURRENCES_PER_CANDIDATE === 0);
    expect(candidates).toHaveLength(CANDIDATE_COUNT);

    const start = performance.now();
    const verdicts = candidates.map((candidate) =>
      isZeroVarianceRepeatCapture(candidate, allCaptures)
    );
    const elapsedMs = performance.now() - start;

    // Every pool path's response is byte-identical across its own
    // occurrences, so `poolPathLooksNoiseShaped` excludes every one of them
    // as a corroborator — `nonNoiseOtherEndpointPaths` comes back empty for
    // every candidate, which `isCorroboratedByStructuralIsolation` reads as
    // "isolated" (nothing survives to share a segment with). The verdict
    // is true for all of them; the interesting thing this test proves is
    // the wall-clock bound below, not the verdict itself.
    expect(verdicts.every((verdict) => verdict === true)).toBe(true);
    expect(elapsedMs).toBeLessThan(3000);
  });
});
