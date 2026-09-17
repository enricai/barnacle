import Bottleneck from "bottleneck";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod/v4";
import { createHttpClient } from "@/scraper/http-client";
import { emitMultiStepExecuteHttp } from "@/scripts/recon-generate";
import { evalExecuteHttpBody } from "@/scripts/recon-generate-execute-http-harness.test-helper";
import { buildStep, type MulticallFixtureStep } from "@/scripts/recon-generate-multicall-fixture";

/**
 * Generic (non-site-specific) sibling of
 * recon-generate-drilldown-fold-runtime-e2e.test.ts: a "venue listing +
 * per-venue seat-map drill" flow with 10 primary items, proving two runtime
 * properties of the generated per-item drill loop that the literal-source
 * assertions elsewhere in this file's family don't reach — (a) the 10 drill
 * fetches actually run concurrently (wall-clock close to one item's delay,
 * not 10x it) and (b) one item's drill failing doesn't abort the response
 * for the other 9 — each item resolves independently.
 */

const VENUE_LIST_URL = "https://api.example.com/venues/search";
const SEATMAP_URL = "https://api.example.com/venues/seatmap";
const DELAY_MS = 150;
const FAILING_VENUE_ID = "v5";

const VENUE_IDS = Array.from({ length: 10 }, (_, i) => `v${i + 1}`);

const SEARCH_RESPONSE_BODY = {
  results: VENUE_IDS.map((venueId) => ({ venueId })),
};

const SEATMAP_BY_VENUE: Record<string, { seatmap: { venueId: string; seats: number }[] }> =
  Object.fromEntries(
    VENUE_IDS.filter((id) => id !== FAILING_VENUE_ID).map((venueId, i) => [
      venueId,
      { seatmap: [{ venueId, seats: 100 + i }] },
    ])
  );

function buildVenueDrillActionSteps(): MulticallFixtureStep[] {
  return [
    buildStep("r0", {
      url: VENUE_LIST_URL,
      requestPostData: '{"page":1}',
      responseBody: SEARCH_RESPONSE_BODY,
      timestamp: "2024-06-01T00:00:00Z",
    }),
    buildStep("r1", {
      url: SEATMAP_URL,
      requestPostData: '{"venueId":"v1"}',
      responseBody: SEATMAP_BY_VENUE.v1,
      timestamp: "2024-06-01T00:00:01Z",
    }),
  ];
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function jsonResponse(
  body: unknown,
  status = 200
): { status: number; ok: boolean; text: () => Promise<string>; headers: Headers } {
  return {
    status,
    ok: status < 400,
    text: vi.fn().mockResolvedValue(JSON.stringify(body)),
    headers: new Headers(),
  };
}

/** Stubs `fetch` to answer the primary search call immediately, and every
 * per-item seat-map drill call after a fixed delay — 9 of 10 items resolve
 * with that item's seat-map, and `FAILING_VENUE_ID` resolves (after the same
 * delay) with a 404, proving the loop tolerates one item's failure without
 * the delay compounding across items (parallel) or the failure propagating
 * to the other items' results (isolated). */
function stubPerItemDrillFetch(): void {
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    if (!url.includes("/venues/seatmap")) {
      return jsonResponse(SEARCH_RESPONSE_BODY);
    }
    const { venueId } = JSON.parse(String(init?.body)) as { venueId: string };
    await delay(DELAY_MS);
    if (venueId === FAILING_VENUE_ID) {
      return jsonResponse({ error: "not found" }, 404);
    }
    const response = SEATMAP_BY_VENUE[venueId];
    if (!response) {
      throw new Error(`stubPerItemDrillFetch: no seatmap fixture for venueId "${venueId}"`);
    }
    return jsonResponse(response);
  });
  vi.stubGlobal("fetch", fn);
}

describe("recon-generate per-item drill loop — concurrency and per-item failure isolation", () => {
  it("runs all 10 items' drill fetches concurrently and keeps the other 9 items' data when exactly one item's drill 404s", async () => {
    const actionSteps = buildVenueDrillActionSteps();
    const inputBody = JSON.parse(actionSteps[0]!.capture.requestPostData ?? "null") as unknown;

    const body = emitMultiStepExecuteHttp(
      actionSteps as unknown as Parameters<typeof emitMultiStepExecuteHttp>[0],
      inputBody,
      { stringMessageKey: null, nestedErrorPaths: [] },
      new Map(),
      new Set(),
      new Map(),
      new Set(),
      new Map(),
      new Map(),
      "https://api.example.com",
      new Map(),
      new Map()
    );

    const limiter = new Bottleneck({ maxConcurrent: 20, minTime: 0 });
    const httpClient = createHttpClient({
      schema: z.unknown(),
      bottleneck: limiter,
      baseHeaders: { "Content-Type": "application/json" },
    });

    stubPerItemDrillFetch();

    const executeHttp = evalExecuteHttpBody(body, httpClient, z);

    const start = performance.now();
    const result = await executeHttp({ BaseUrl: "https://api.example.com", page: 1 });
    const elapsedMs = performance.now() - start;

    // 10 sequential drill fetches at DELAY_MS each would take ~10x DELAY_MS;
    // concurrent execution takes ~1x DELAY_MS regardless of item count. A
    // generous 3x-DELAY_MS ceiling comfortably separates the two shapes
    // without being flaky under CI scheduling jitter.
    expect(elapsedMs).toBeLessThan(DELAY_MS * 3);

    const resultBody = result.data as { results: { venueId: string; seats?: number }[] };
    expect(resultBody.results).toHaveLength(10);

    const failingItem = resultBody.results.find((item) => item.venueId === FAILING_VENUE_ID);
    expect(failingItem).toBeDefined();
    expect(failingItem?.seats).toBeUndefined();

    const succeedingItems = resultBody.results.filter((item) => item.venueId !== FAILING_VENUE_ID);
    expect(succeedingItems).toHaveLength(9);
    for (const item of succeedingItems) {
      expect(item.seats).toBeGreaterThanOrEqual(100);
    }

    // Primary call + one drill fetch per item (10), regardless of the one 404.
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(11);
  });
});
