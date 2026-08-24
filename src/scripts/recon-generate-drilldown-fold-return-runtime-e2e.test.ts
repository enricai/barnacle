import Bottleneck from "bottleneck";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod/v4";
import { createHttpClient } from "@/scraper/http-client";
import { emitMultiStepExecuteHttp, type FoldReturnSpec } from "@/scripts/recon-generate";
import { evalExecuteHttpBody } from "@/scripts/recon-generate-execute-http-harness.test-helper";
import {
  buildMulticallSingleShotSearchDrillDownHeaderThreadedJoinRequeriedPrimaryOverlapActionSteps,
  buildStep,
  type MulticallFixtureStep,
} from "@/scripts/recon-generate-multicall-fixture";

/**
 * A search → per-item drill-down pair whose join value threads ONLY through
 * a request header (`X-Item-Sku`), so `detectDrillDownFoldPlan`'s structural
 * heuristic — which never scans headers — resolves nothing here and
 * `buildFoldPlanFromSpec` is the only path left to fold. Both sides also
 * carry a decoy array (`facets[]` ahead of `results[]` on the primary,
 * `errors[]` ahead of `details[]` on the drill) that a DFS-first array match
 * would land on instead of the real one, so a resolved fold here proves the
 * declared `resultsPath`/`drillResultsPath` — not array order — picked the
 * primary and drill arrays.
 */
function buildHeaderThreadedDoubleDecoyDrillDownActionSteps(): MulticallFixtureStep[] {
  return [
    buildStep("r0", {
      url: "https://api.example.com/catalog/search/",
      requestPostData: '{"page":1}',
      responseBody: {
        facets: [{ name: "brand" }],
        results: [{ sku: "sku-a" }, { sku: "sku-b" }],
      },
      timestamp: "2024-04-01T00:00:00Z",
    }),
    buildStep("r1", {
      url: "https://api.example.com/catalog/pricing/",
      requestPostData: '{"lookup":true}',
      requestHeaders: { "Content-Type": "application/json", "X-Item-Sku": "sku-a" },
      responseBody: {
        errors: [{ code: "none" }],
        details: [{ sku: "sku-a", price: 19.99 }],
      },
      timestamp: "2024-04-01T00:00:01Z",
    }),
  ];
}

const HEADER_THREADED_DOUBLE_DECOY_SPEC: FoldReturnSpec = {
  endpointPattern: "/catalog/pricing/",
  resultsPath: "results",
  drillResultsPath: "details",
  joinFields: ["sku"],
};

function jsonResponse(body: unknown): {
  status: number;
  ok: boolean;
  text: () => Promise<string>;
  headers: Headers;
} {
  return {
    status: 200,
    ok: true,
    text: vi.fn().mockResolvedValue(JSON.stringify(body)),
    headers: new Headers(),
  };
}

/** Stubs `fetch` to answer the primary search call with the decoy+real
 * search body, and every drill-down call (regardless of request shape, since
 * the join value only ever threaded through a header the emitted code never
 * resends — see `buildHeaderThreadedDoubleDecoyDrillDownActionSteps`'s
 * docstring) with a single response carrying BOTH items' pricing entries.
 * The per-item correctness this proves lives entirely in the generated
 * fold-and-merge loop matching each response entry against its own primary
 * item, not in the request being distinguishable per item. */
function stubDrillDecoyFetch(): void {
  const fn = vi.fn(async (url: string) => {
    if (!url.includes("/catalog/pricing/")) {
      return jsonResponse({
        facets: [{ name: "brand" }],
        results: [{ sku: "sku-a" }, { sku: "sku-b" }],
      });
    }
    return jsonResponse({
      errors: [{ code: "none" }],
      details: [
        { sku: "sku-a", price: 19.99 },
        { sku: "sku-b", price: 24.99 },
      ],
    });
  });
  vi.stubGlobal("fetch", fn);
}

describe("recon-generate drill-down foldReturn spec executeHttp — generated-and-run runtime guard", () => {
  it("falsifier: without a FoldReturnSpec, the structural heuristic emits no fold loop for this header-threaded fixture", () => {
    const actionSteps = buildHeaderThreadedDoubleDecoyDrillDownActionSteps();
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
      new Map(),
      null,
      new Map(),
      new Map(),
      new Set(),
      [],
      new Map(),
      new Map(),
      null
    );

    expect(body).not.toContain("for (const item of foldItems)");
  });

  it("folds the declared drill-down onto EVERY primary item at runtime, resolving the declared resultsPath/drillResultsPath over the DFS-first decoy arrays", async () => {
    const actionSteps = buildHeaderThreadedDoubleDecoyDrillDownActionSteps();
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
      new Map(),
      null,
      new Map(),
      new Map(),
      new Set(),
      [],
      new Map(),
      new Map(),
      HEADER_THREADED_DOUBLE_DECOY_SPEC
    );

    const limiter = new Bottleneck({ maxConcurrent: 1, minTime: 0 });
    const httpClient = createHttpClient({
      schema: z.unknown(),
      bottleneck: limiter,
      baseHeaders: { "Content-Type": "application/json" },
    });

    stubDrillDecoyFetch();

    const executeHttp = evalExecuteHttpBody(body, httpClient, z);
    const result = await executeHttp({ BaseUrl: "https://api.example.com", page: 1 });

    expect(result.data).toEqual({
      facets: [{ name: "brand" }],
      results: [
        { sku: "sku-a", price: 19.99 },
        { sku: "sku-b", price: 24.99 },
      ],
    });
    // One primary call plus one drill-down call per primary item.
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(3);
  });
});

const REQUERIED_PRIMARY_SPEC: FoldReturnSpec = {
  endpointPattern: "/accounts/detail",
  resultsPath: "accounts",
  joinFields: ["accountId"],
};

/** Stubs `fetch` to answer the primary search call TWICE with different
 * `accounts[]` payloads (stale "Acme" first, freshest "Acme Corp" second —
 * mirroring the requery in
 * {@link buildMulticallSingleShotSearchDrillDownHeaderThreadedJoinRequeriedPrimaryOverlapActionSteps}),
 * then the drill-down call with the account's transaction. Proves the
 * emitted code's own fold loop, not just `resolveFoldPlan`, is built off
 * the freshest ("Acme Corp") occurrence. */
function stubRequeriedPrimaryFetch(): void {
  let searchCallCount = 0;
  const fn = vi.fn(async (url: string) => {
    if (url.includes("/accounts/detail")) {
      return jsonResponse({ transactions: [{ transactionId: "t1" }] });
    }
    const isFirstSearchCall = searchCallCount === 0;
    searchCallCount += 1;
    return jsonResponse({
      accounts: [{ accountId: 42, name: isFirstSearchCall ? "Acme" : "Acme Corp" }],
    });
  });
  vi.stubGlobal("fetch", fn);
}

describe("recon-generate drill-down foldReturn spec executeHttp — freshest re-queried primary runtime guard", () => {
  it("folds the drill-down onto the freshest re-queried primary occurrence at runtime, not the stale one", async () => {
    const actionSteps =
      buildMulticallSingleShotSearchDrillDownHeaderThreadedJoinRequeriedPrimaryOverlapActionSteps();
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
      new Map(),
      null,
      new Map(),
      new Map(),
      new Set(),
      [],
      new Map(),
      new Map(),
      REQUERIED_PRIMARY_SPEC
    );

    const limiter = new Bottleneck({ maxConcurrent: 1, minTime: 0 });
    const httpClient = createHttpClient({
      schema: z.unknown(),
      bottleneck: limiter,
      baseHeaders: { "Content-Type": "application/json" },
    });

    stubRequeriedPrimaryFetch();

    const executeHttp = evalExecuteHttpBody(body, httpClient, z);
    const result = await executeHttp({ BaseUrl: "https://api.example.com", page: 1 });

    expect(result.data).toEqual({
      accounts: [{ accountId: 42, name: "Acme Corp", transactionId: "t1" }],
    });
    // Both primary calls (stale + freshest re-query) plus one drill-down call.
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(3);
  });
});

/**
 * A search → per-item drill-down pair whose join value threads ONLY through
 * a request header (`X-Item-Sku`), so `detectDrillDownFoldPlan`'s structural
 * heuristic — which never scans headers — resolves nothing here and
 * `buildFoldPlanFromSpec` is the only path left to fold. The drill endpoint
 * (`/catalog/pricing/`) was captured TWICE (`r1`, `r2`), both independently
 * satisfying the spec's join against the single primary item: `r1` is a
 * plain lookup, `r2` is a later "refresh" re-query with a different response
 * payload. `buildFoldPlanFromSpec`'s inner drill loop must retain the LAST
 * (freshest) `drillStepIndex` — `r2` — as the template for the per-item fold
 * call, not `r1`.
 */
function buildHeaderThreadedDrillCalledTwiceActionSteps(): MulticallFixtureStep[] {
  return [
    buildStep("r0", {
      url: "https://api.example.com/catalog/search/",
      requestPostData: '{"page":1}',
      responseBody: { results: [{ sku: "sku-a" }] },
      timestamp: "2024-04-01T00:00:00Z",
    }),
    buildStep("r1", {
      url: "https://api.example.com/catalog/pricing/",
      requestPostData: '{"lookup":true}',
      requestHeaders: { "Content-Type": "application/json", "X-Item-Sku": "sku-a" },
      responseBody: { prices: [{ sku: "sku-a", amount: 19.99 }] },
      timestamp: "2024-04-01T00:00:01Z",
    }),
    buildStep("r2", {
      url: "https://api.example.com/catalog/pricing/",
      requestPostData: '{"lookup":true,"refresh":true}',
      requestHeaders: { "Content-Type": "application/json", "X-Item-Sku": "sku-a" },
      responseBody: { prices: [{ sku: "sku-a", amount: 24.99 }] },
      timestamp: "2024-04-01T00:00:02Z",
    }),
  ];
}

const HEADER_THREADED_DRILL_CALLED_TWICE_SPEC: FoldReturnSpec = {
  endpointPattern: "/catalog/pricing/",
  resultsPath: "results",
  drillResultsPath: "prices",
  joinFields: ["sku"],
};

/** Stubs `fetch` to answer the primary search call with its recorded body,
 * and to distinguish the two possible shapes of the drill-down request by
 * their `refresh` flag: the emitted code replays `r1`'s stale request body
 * verbatim (it wasn't selected into the fold plan) ahead of the per-item
 * loop, which issues the freshest (`r2`, `refresh: true`) request as its
 * template — so both request shapes actually reach `fetch`, each answered
 * with its own distinct payload, making which one got folded observable. */
function stubDrillCalledTwiceFetch(): void {
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    if (!url.includes("/catalog/pricing/")) {
      return jsonResponse({ results: [{ sku: "sku-a" }] });
    }
    const requestBody = init?.body
      ? (JSON.parse(String(init.body)) as { refresh?: boolean })
      : null;
    return requestBody?.refresh === true
      ? jsonResponse({ prices: [{ sku: "sku-a", amount: 24.99 }] })
      : jsonResponse({ prices: [{ sku: "sku-a", amount: 19.99 }] });
  });
  vi.stubGlobal("fetch", fn);
}

describe("recon-generate drill-down foldReturn spec executeHttp — freshest re-queried drill runtime guard", () => {
  it("folds the drilled field onto the freshest re-queried drill occurrence, not the stale one", async () => {
    const actionSteps = buildHeaderThreadedDrillCalledTwiceActionSteps();
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
      new Map(),
      null,
      new Map(),
      new Map(),
      new Set(),
      [],
      new Map(),
      new Map(),
      HEADER_THREADED_DRILL_CALLED_TWICE_SPEC
    );

    const limiter = new Bottleneck({ maxConcurrent: 1, minTime: 0 });
    const httpClient = createHttpClient({
      schema: z.unknown(),
      bottleneck: limiter,
      baseHeaders: { "Content-Type": "application/json" },
    });

    stubDrillCalledTwiceFetch();

    const executeHttp = evalExecuteHttpBody(body, httpClient, z);
    const result = await executeHttp({
      BaseUrl: "https://api.example.com",
      page: 1,
      lookup: true,
      refresh: true,
    });

    expect(result.data).toEqual({
      results: [{ sku: "sku-a", amount: 24.99 }],
    });
    // Primary search call, the stale drill-down replay, and the freshest
    // per-item fold call.
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(3);
  });
});
