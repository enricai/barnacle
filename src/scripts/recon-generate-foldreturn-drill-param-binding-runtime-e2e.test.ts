import Bottleneck from "bottleneck";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod/v4";
import { createHttpClient } from "@/scraper/http-client";
import { emitMultiStepExecuteHttp, type FoldReturnSpec } from "@/scripts/recon-generate";
import { evalExecuteHttpBody } from "@/scripts/recon-generate-execute-http-harness.test-helper";
import { buildMulticallSingleShotSearchDrillDownConstantParamCoincidentValueActionSteps } from "@/scripts/recon-generate-multicall-fixture";

const UNBOUND_SPEC: FoldReturnSpec = {
  endpointPattern: "catalog/item-quote",
  resultsPath: "results",
  joinFields: ["itemId"],
};

const BOUND_SPEC: FoldReturnSpec = {
  ...UNBOUND_SPEC,
  drillParamBindings: {
    qty: { payloadField: "quantity", type: "int", default: 5 },
  },
};

function emitBody(spec: FoldReturnSpec): string {
  const actionSteps =
    buildMulticallSingleShotSearchDrillDownConstantParamCoincidentValueActionSteps();
  return emitMultiStepExecuteHttp(
    actionSteps as unknown as Parameters<typeof emitMultiStepExecuteHttp>[0],
    null,
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
    spec
  );
}

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

/** Stubs `fetch` to answer the primary search call, then answer every drill
 * call by echoing the `qty` query param it was actually called with back as
 * `quotes[0].price`, so the test can assert the runtime-bound value reached
 * the outbound request without inspecting `fetch`'s call args directly. */
function stubDrillFetchEchoingQty(): void {
  const fn = vi.fn(async (url: string) => {
    if (!url.includes("/catalog/item-quote")) {
      return jsonResponse({
        results: [
          { itemId: "i1", discount: 99 },
          { itemId: "i2", discount: 0 },
        ],
      });
    }
    const parsed = new URL(url);
    const qty = parsed.searchParams.get("qty");
    const itemId = parsed.searchParams.get("itemId");
    return jsonResponse({ quotes: [{ itemId, price: Number(qty) }] });
  });
  vi.stubGlobal("fetch", fn);
}

describe("recon-generate — drillParamBindings wired into emitMultiStepExecuteHttp's fold parameterize pass", () => {
  it("emits the payload accessor (with default) for a bound drill param instead of the frozen literal", () => {
    const body = emitBody(BOUND_SPEC);

    expect(body).toContain("qty=${payload.quantity ?? 5}");
    expect(body).not.toContain("qty=0");
  });

  it("still emits the frozen literal, byte-identical to the unbound emission, when no drillParamBindings are declared", () => {
    const bound = emitBody(BOUND_SPEC);
    const unbound = emitBody(UNBOUND_SPEC);

    expect(unbound).toContain("qty=0");
    expect(unbound).not.toContain("${payload.quantity");
    expect(unbound.split("qty=0").join("qty=X")).toBe(
      bound.split("qty=${payload.quantity ?? 5}").join("qty=X")
    );
  });

  it("threads the caller's payload field into the outbound drill request at runtime", async () => {
    const body = emitBody(BOUND_SPEC);

    const limiter = new Bottleneck({ maxConcurrent: 1, minTime: 0 });
    const httpClient = createHttpClient({
      schema: z.unknown(),
      bottleneck: limiter,
      baseHeaders: { "Content-Type": "application/json" },
    });

    stubDrillFetchEchoingQty();

    const executeHttp = evalExecuteHttpBody(body, httpClient, z);
    const result = await executeHttp({ BaseUrl: "https://api.example.com", quantity: 7 });

    expect(result.data).toEqual({
      results: [
        { itemId: "i1", discount: 99, price: 7 },
        { itemId: "i2", discount: 0, price: 7 },
      ],
    });
  });

  it("falls back to the declared default when the caller omits the bound payload field", async () => {
    const body = emitBody(BOUND_SPEC);

    const limiter = new Bottleneck({ maxConcurrent: 1, minTime: 0 });
    const httpClient = createHttpClient({
      schema: z.unknown(),
      bottleneck: limiter,
      baseHeaders: { "Content-Type": "application/json" },
    });

    stubDrillFetchEchoingQty();

    const executeHttp = evalExecuteHttpBody(body, httpClient, z);
    const result = await executeHttp({ BaseUrl: "https://api.example.com" });

    expect(result.data).toEqual({
      results: [
        { itemId: "i1", discount: 99, price: 5 },
        { itemId: "i2", discount: 0, price: 5 },
      ],
    });
  });
});
