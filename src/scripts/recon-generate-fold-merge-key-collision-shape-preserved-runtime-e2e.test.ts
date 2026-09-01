import Bottleneck from "bottleneck";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod/v4";
import { createHttpClient } from "@/scraper/http-client";
import { emitMultiStepExecuteHttp, inferZodSchemaFromSamples } from "@/scripts/recon-generate";
import { evalExecuteHttpBody } from "@/scripts/recon-generate-execute-http-harness.test-helper";
import { buildMulticallSingleShotSearchDrillDownSharedKeyDifferentShapeActionSteps } from "@/scripts/recon-generate-multicall-fixture";

const SEARCH_RESPONSE_BODY = {
  results: [{ sku: "sku-a", fees: { value: 5 } }],
};
const PRICING_RESPONSE_BODY = {
  prices: [{ sku: "sku-a", amount: 19.99, fees: { amount: 2, total: 21.99 } }],
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

/** Stubs `fetch` to answer the primary search call with `SEARCH_RESPONSE_BODY`
 * and every drill-down call with `PRICING_RESPONSE_BODY`, whose `fees` shape
 * deliberately collides with — but does not match — the primary's `fees`. */
function stubCollidingFeesFetch(): void {
  const fn = vi.fn(async (url: string) => {
    if (!url.includes("/catalog/pricing/")) {
      return jsonResponse(SEARCH_RESPONSE_BODY);
    }
    return jsonResponse(PRICING_RESPONSE_BODY);
  });
  vi.stubGlobal("fetch", fn);
}

/**
 * Regression for docs/recon-generate-fold-object-assign-clobbers-field-its-own-responseschema-pins.md:
 * folding a drill-down response onto a primary item must not let the drill's
 * `fees` shape overwrite the primary's own `fees` shape when both sides carry
 * a field with the same key but an incompatible shape. Proves this at both
 * emit-time (the generated executeHttp's actual runtime merge) and via a
 * schema built from the primary's own pre-fold samples still accepting the
 * folded output.
 */
describe("recon-generate fold merge — shared-key/different-shape collision does not clobber the primary field", () => {
  const actionSteps = buildMulticallSingleShotSearchDrillDownSharedKeyDifferentShapeActionSteps();

  it("the generated-and-run executeHttp preserves the primary's fees value, and a schema inferred from the primary's own pre-fold samples still accepts it", async () => {
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

    const limiter = new Bottleneck({ maxConcurrent: 1, minTime: 0 });
    const httpClient = createHttpClient({
      schema: z.unknown(),
      bottleneck: limiter,
      baseHeaders: { "Content-Type": "application/json" },
    });

    stubCollidingFeesFetch();

    const executeHttp = evalExecuteHttpBody(body, httpClient, z);
    const result = await executeHttp({ BaseUrl: "https://api.example.com", page: 1 });

    expect(result.data).toEqual({
      results: [{ sku: "sku-a", fees: { value: 5 }, amount: 19.99 }],
    });

    const primarySchemaExpr = inferZodSchemaFromSamples([SEARCH_RESPONSE_BODY]);
    const PrimarySchema: z.ZodTypeAny = new Function("z", `return ${primarySchemaExpr};`)(z);
    const parsed = PrimarySchema.safeParse(result.data);
    expect(parsed.success).toBe(true);
  });
});
