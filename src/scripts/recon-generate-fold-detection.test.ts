import { describe, expect, it } from "vitest";
import { detectFoldPlan, parseFoldReturnSpec } from "@/scripts/recon-generate";
import {
  buildCapture,
  buildMulticallHeterogeneousActionSteps,
  buildMulticallHeterogeneousActionStepsWithDrillDown,
  buildStep,
  type MulticallFixtureStep,
} from "@/scripts/recon-generate-multicall-fixture";

/** `detectFoldPlan` takes the unexported `ActionStep[]`; the shared fixture's
 * `MulticallFixtureStep` is structurally identical except for `produces`
 * (`unknown[]` vs. the real `Produce[]`), so a type-only cast through the
 * function's own parameter type is safe — same pattern as
 * recon-generate-multistep-return.test.ts's `emit` helper. */
function detect(steps: unknown[]): ReturnType<typeof detectFoldPlan> {
  return detectFoldPlan(steps as unknown as Parameters<typeof detectFoldPlan>[0]);
}

/** A step whose response is a search-result ARRAY, with a `produces` entry
 * pointing at a field one level inside an array item (a non-terminal
 * array-index path segment) — the shape `detectFoldPlan` looks for. */
function buildSearchStepWithArrayProduce(): MulticallFixtureStep {
  const step = buildStep("r0", {
    url: "https://api.example.com/catalog/search",
    requestPostData: '{"query":"widgets"}',
    responseBody: {
      results: [{ itemCode: "WIDGET-42", name: "Widget" }],
    },
    timestamp: "2024-01-01T00:00:00Z",
  });
  return {
    ...step,
    produces: [
      { kind: "body", name: "itemCode", path: ["results", "0", "itemCode"] },
    ] as unknown as never[],
  };
}

function buildDrillDownStep(joinValue: string): MulticallFixtureStep {
  return buildStep("r1", {
    url: `https://api.example.com/catalog/pricing?itemCode=${joinValue}`,
    requestPostData: null,
    responseBody: { pricing: { amount: 19.99 } },
    timestamp: "2024-01-01T00:00:01Z",
  });
}

describe("detectFoldPlan", () => {
  it("detects a search → drill-down fold when a produce's path threads a value from inside an array into a strictly-later request", () => {
    const searchStep = buildSearchStepWithArrayProduce();
    const drillStep = buildDrillDownStep("WIDGET-42");

    const plan = detect([searchStep, drillStep]);

    if (plan === null) throw new Error("expected a fold plan");
    expect(plan.arrayContainerPath).toEqual(["results"]);
    expect(plan.joinFields).toEqual(["itemCode"]);
    expect((plan.primaryAction as MulticallFixtureStep).varName).toBe("r0");
    expect((plan.drillAction as MulticallFixtureStep).varName).toBe("r1");
  });

  it("returns null for a plain re-queried search with no array-nested produce (G1)", () => {
    expect(detect(buildMulticallHeterogeneousActionSteps())).toBeNull();
  });

  it("returns null for a plain multi-step submission flow with no re-query and no array-nested produce (G1)", () => {
    expect(detect(buildMulticallHeterogeneousActionStepsWithDrillDown())).toBeNull();
  });

  it("returns null when the array-index segment is the terminal path segment (not nested further)", () => {
    const step = buildStep("r0", {
      url: "https://api.example.com/catalog/search",
      requestPostData: null,
      responseBody: { tags: ["red", "blue"] },
      timestamp: "2024-01-01T00:00:00Z",
    });
    const withProduce: MulticallFixtureStep = {
      ...step,
      produces: [{ kind: "body", name: "tag", path: ["tags", "0"] }] as unknown as never[],
    };
    const drillStep = buildDrillDownStep("red");

    expect(detect([withProduce, drillStep])).toBeNull();
  });

  it("returns null when no strictly-later action references the array-nested value", () => {
    const searchStep = buildSearchStepWithArrayProduce();
    const unrelatedStep = buildCapture({
      url: "https://api.example.com/catalog/unrelated",
      requestPostData: '{"foo":"bar"}',
      responseBody: { ok: true },
      timestamp: "2024-01-01T00:00:01Z",
    });

    const plan = detect([
      searchStep,
      {
        capture: unrelatedStep,
        varName: "r1",
        produces: [],
        isMultipart: false,
        isCrossDomain: false,
      },
    ]);

    expect(plan).toBeNull();
  });
});

describe("parseFoldReturnSpec", () => {
  it("parses a present, well-formed foldReturn block", () => {
    const flow = JSON.stringify({
      steps: ["Search"],
      foldReturn: {
        endpointPattern: "/catalog/pricing",
        resultsPath: "results",
        joinField: "itemCode",
      },
    });

    expect(parseFoldReturnSpec(flow)).toEqual({
      endpointPattern: "/catalog/pricing",
      resultsPath: "results",
      joinField: "itemCode",
    });
  });

  it("returns null when foldReturn is absent", () => {
    const flow = JSON.stringify({ steps: ["Search"] });
    expect(parseFoldReturnSpec(flow)).toBeNull();
  });

  it("returns null for an array-form flow (foldReturn has nowhere to live)", () => {
    const flow = JSON.stringify(["Search", "Submit"]);
    expect(parseFoldReturnSpec(flow)).toBeNull();
  });

  it("returns null when foldReturn is present but has a malformed (non-string) field", () => {
    const flow = JSON.stringify({
      steps: ["Search"],
      foldReturn: {
        endpointPattern: "/catalog/pricing",
        resultsPath: "results",
        joinField: 42,
      },
    });

    expect(parseFoldReturnSpec(flow)).toBeNull();
  });

  it("returns null when foldReturn is present but missing a required field", () => {
    const flow = JSON.stringify({
      steps: ["Search"],
      foldReturn: {
        endpointPattern: "/catalog/pricing",
        resultsPath: "results",
      },
    });

    expect(parseFoldReturnSpec(flow)).toBeNull();
  });

  it("returns null on malformed JSON", () => {
    expect(parseFoldReturnSpec("{not json")).toBeNull();
  });
});
