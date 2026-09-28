import { describe, expect, it } from "vitest";
import { type FoldPlan, type FoldReturnSpec, resolveFoldPlan } from "@/scripts/recon-generate";
import { buildStep, type MulticallFixtureStep } from "@/scripts/recon-generate-multicall-fixture";

const SEARCH_URL = "https://api.example.com/catalog/search/";
const TOKEN_URL = "https://api.example.com/catalog/token/";
const PRICING_URL = "https://api.example.com/catalog/pricing/";

const SPEC: FoldReturnSpec = {
  endpointPattern: "/catalog/pricing/",
  resultsPath: "results",
  joinFields: ["sku"],
};

const timestampAt = (index: number): string =>
  `2024-11-01T00:00:${String(index).padStart(2, "0")}.000Z`;

const primaryStep = (index: number, skus: string[]): MulticallFixtureStep =>
  buildStep(`primary-${index}`, {
    url: SEARCH_URL,
    requestPostData: `{"page":${index + 1}}`,
    responseBody: { results: skus.map((sku) => ({ sku })) },
    timestamp: timestampAt(index),
  });

const responseOnlyDrillStep = (index: number, sku: string): MulticallFixtureStep =>
  buildStep(`drill-${index}`, {
    url: PRICING_URL,
    requestPostData: `{"lookup":${index}}`,
    responseBody: { prices: [{ sku, amount: 9.99 }] },
    timestamp: timestampAt(index),
  });

// The pruning in buildFoldPlanFromSpec must only skip drills that could never
// resolve, so each case below pins a resolution path the pruning has to keep.
describe("resolveFoldPlan drill pruning", () => {
  it("still resolves a drill whose join value is carried only by its response, among noise drills", () => {
    const steps = [
      primaryStep(0, ["sku-real"]),
      responseOnlyDrillStep(1, "sku-noise-1"),
      responseOnlyDrillStep(2, "sku-real"),
      responseOnlyDrillStep(3, "sku-noise-3"),
    ];

    const plans = resolveFoldPlan(steps, SPEC) as FoldPlan[];

    expect(plans).toHaveLength(1);
    expect(plans[0]?.primaryStepIndex).toBe(0);
    expect(plans[0]?.targets[0]?.drillStepIndex).toBe(2);
    expect(plans[0]?.targets[0]?.primaryMatchedItemIndex).toBe(0);
  });

  it("prefers the freshest drill when several drills resolve", () => {
    const steps = [
      primaryStep(0, ["sku-a", "sku-b"]),
      responseOnlyDrillStep(1, "sku-a"),
      responseOnlyDrillStep(2, "sku-b"),
    ];

    const plans = resolveFoldPlan(steps, SPEC) as FoldPlan[];

    expect(plans).toHaveLength(1);
    expect(plans[0]?.targets[0]?.drillStepIndex).toBe(2);
    expect(plans[0]?.targets[0]?.primaryMatchedItemIndex).toBe(1);
  });

  it("resolves through an upstream request-carried entry hop that precedes the matching drill", () => {
    const steps = [
      primaryStep(0, ["sku-real"]),
      buildStep("entry", {
        url: TOKEN_URL,
        requestPostData: '{"mint":true}',
        responseBody: { token: "tok-real" },
        timestamp: timestampAt(1),
        requestHeaders: { "Content-Type": "application/json", "X-Item-Sku": "sku-real" },
      }),
      buildStep("noise-drill", {
        url: PRICING_URL,
        requestPostData: '{"lookup":"noise"}',
        responseBody: { prices: [{ sku: "sku-noise", amount: 1 }] },
        timestamp: timestampAt(2),
        requestHeaders: { "Content-Type": "application/json", "X-Item-Sku": "sku-noise" },
      }),
      buildStep("drill", {
        url: PRICING_URL,
        requestPostData: '{"token":"tok-real"}',
        responseBody: { prices: [{ sku: "sku-real", amount: 19.99 }] },
        timestamp: timestampAt(3),
      }),
    ];

    const plans = resolveFoldPlan(steps, SPEC) as FoldPlan[];

    expect(plans).toHaveLength(1);
    expect(plans[0]?.targets[0]?.drillStepIndex).toBe(1);
    expect(plans[0]?.targets[0]?.chain).toEqual([1, 3]);
  });

  it("returns no plan when no drill carries any primary join value", () => {
    const steps = [
      primaryStep(0, ["sku-real"]),
      responseOnlyDrillStep(1, "sku-noise-1"),
      responseOnlyDrillStep(2, "sku-noise-2"),
    ];

    expect(resolveFoldPlan(steps, SPEC)).toEqual([]);
  });
});
