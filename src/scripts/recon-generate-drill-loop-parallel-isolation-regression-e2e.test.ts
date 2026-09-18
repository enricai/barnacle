import Bottleneck from "bottleneck";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod/v4";
import { createHttpClient } from "@/scraper/http-client";
import {
  compileActionSteps,
  emitMultiStepExecuteHttp,
  indexStateValues,
} from "@/scripts/recon-generate";
import { evalExecuteHttpBody } from "@/scripts/recon-generate-execute-http-harness.test-helper";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";

const SEARCH_URL = "https://api.example.com/catalog/search/";
const DRILL_URL = "https://api.example.com/catalog/detail/";

const ITEM_COUNT = 8;
const FAILING_ID = "id-3";
// Long enough that a genuinely sequential (one-request-at-a-time) loop could
// never observe more than one in-flight drill request at once, short enough
// to keep the test fast.
const CALL_LATENCY_MS = 20;

const ids = Array.from({ length: ITEM_COUNT }, (_, i) => `id-${i}`);
const SEARCH_BODY = { results: ids.map((id) => ({ id })) };
const DETAIL_BODY_FOR = (id: string): { detail: unknown[] } => ({
  detail: [{ id, weight: 42 }],
});

/**
 * Reproduces the same single-hop search + per-item drill-down shape used
 * elsewhere in this file set, sized large enough for a timing-based
 * assertion to distinguish a genuinely concurrent per-item drill loop from a
 * sequential one.
 */
function buildRecordedCaptures(): ReturnType<typeof buildCapture>[] {
  return [
    buildCapture({
      url: SEARCH_URL,
      requestPostData: '{"page":1}',
      responseBody: SEARCH_BODY,
      timestamp: "2024-11-15T00:00:00Z",
    }),
    buildCapture({
      url: DRILL_URL,
      requestPostData: '{"id":"id-0"}',
      responseBody: DETAIL_BODY_FOR("id-0"),
      timestamp: "2024-11-15T00:00:01Z",
    }),
  ];
}

/**
 * Stubs `fetch`: the search call resolves immediately, every drill call
 * takes `CALL_LATENCY_MS` to resolve, and `FAILING_ID`'s own drill call 403s
 * (a non-retryable abort in `createHttpClient`) instead of resolving.
 * `maxInFlight` is filled in with the highest number of drill calls this
 * stub ever saw outstanding at once.
 */
function stubDrillFetch(maxInFlight: { value: number }): void {
  let inFlight = 0;
  const fn = vi.fn().mockImplementation((_url: string, init?: { body?: string }) => {
    const requestBody = init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    if (requestBody === null || typeof requestBody.page === "number") {
      return Promise.resolve({
        status: 200,
        ok: true,
        text: vi.fn().mockResolvedValue(JSON.stringify(SEARCH_BODY)),
        headers: new Headers(),
      });
    }
    const id = requestBody.id as string;
    inFlight++;
    maxInFlight.value = Math.max(maxInFlight.value, inFlight);
    return new Promise((resolve) => {
      setTimeout(() => {
        inFlight--;
        if (id === FAILING_ID) {
          resolve({
            status: 403,
            ok: false,
            text: vi.fn().mockResolvedValue(JSON.stringify({ error: "forbidden" })),
            headers: new Headers(),
          });
          return;
        }
        resolve({
          status: 200,
          ok: true,
          text: vi.fn().mockResolvedValue(JSON.stringify(DETAIL_BODY_FOR(id))),
          headers: new Headers(),
        });
      }, CALL_LATENCY_MS);
    });
  });
  vi.stubGlobal("fetch", fn);
}

describe("recon-generate per-item drill loop — parallel dispatch survives a single item's failure", () => {
  it("emits a Promise.allSettled per-item loop and merges every non-failing item even though one item's drill fetch rejects", async () => {
    const captures = buildRecordedCaptures();
    const inputBody = JSON.parse(captures[0]!.requestPostData ?? "null") as unknown;

    const actionCaptures = captures.map((capture, index) => ({ capture, index }));
    const stateIndex = indexStateValues(captures);
    const actionSteps = compileActionSteps(actionCaptures as never, stateIndex);

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

    // The per-item loop dispatches through Promise.allSettled, not a bare
    // `for (const item of foldItems) { await ... }` with no isolation.
    expect(body).toContain("Promise.allSettled(");
    expect(body).toMatch(/foldItems\)\.map\(async \(item\) => \{/);

    const limiter = new Bottleneck({ maxConcurrent: ITEM_COUNT, minTime: 0 });
    const httpClient = createHttpClient({
      schema: z.unknown(),
      bottleneck: limiter,
      baseHeaders: { "Content-Type": "application/json" },
    });

    const maxInFlight = { value: 0 };
    stubDrillFetch(maxInFlight);

    const executeHttp = evalExecuteHttpBody(body, httpClient, z);
    const result = await executeHttp({ BaseUrl: "https://api.example.com", page: 1 });

    // One item's rejected fetch does not throw out of the loop and fail the
    // whole response — every other item's merged data still comes back.
    const data = result.data as { results?: Array<Record<string, unknown>> };
    expect(data.results).toHaveLength(ITEM_COUNT);

    const byId = new Map((data.results ?? []).map((item) => [item.id as string, item]));
    for (const id of ids) {
      if (id === FAILING_ID) {
        expect(byId.get(id)).toEqual({ id });
        continue;
      }
      expect(byId.get(id)).toEqual({ id, weight: 42 });
    }

    // A sequential loop could never have more than one drill call
    // outstanding within CALL_LATENCY_MS — this proves genuine concurrency.
    expect(maxInFlight.value).toBeGreaterThan(1);

    // One primary call, plus one drill call per item.
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1 + ITEM_COUNT);
  });
});
