import { describe, expect, it } from "vitest";
import {
  emitContractTs,
  selectEffectiveResponseBody,
  selectReturnAction,
} from "@/scripts/recon-generate";
import {
  buildMulticallHeterogeneousActionStepsWithDrillDown,
  type MulticallFixtureStep,
} from "@/scripts/recon-generate-multicall-fixture";

/**
 * Pins G1's second surface: recon-generate.ts's response-shape-inference
 * target (formerly `actionSteps[actionSteps.length - 1]`) must agree with
 * the return-value target (`selectReturnAction`, recon-generate.ts:2255).
 * A fix applied only at the return site would leave the emitted schema/type
 * describing a different call than the one `executeHttp` actually returns.
 * `selectEffectiveResponseBody` is the extracted call-site helper (matching
 * `selectReturnAction`'s own extraction) that delegates to
 * `selectReturnAction`, guaranteeing the two selections structurally cannot
 * drift apart.
 *
 * The emitted response SCHEMA is inferred from the same selected body on the
 * real multi-step path too (`multiStepBody` set): the client-level schema
 * describes the same call `executeHttp` returns (`selectReturnAction`), so
 * shape inference is not gated behind `multiStepBody` truthiness. Both the
 * `multiStepBody`-unset and `multiStepBody`-set assertions below therefore
 * observe the same inferred shape.
 */
describe("recon-generate — G1 shape-inference target agrees with the return target", () => {
  const steps: MulticallFixtureStep[] = buildMulticallHeterogeneousActionStepsWithDrillDown();
  // selectReturnAction/selectEffectiveResponseBody pick the MOST RECENT
  // re-queried instance — r3 (page 2), not r2 (page 1) — as the freshest
  // answer from the flow's subject.
  const inventoryStep = steps[3]!; // r3: available-products/, page 2
  const drillDownStep = steps[4]!; // r4: available-units/ terminal drill-down

  it("selects the re-queried inventory call's body, not the terminal drill-down's", () => {
    const effectiveResponseBody = selectEffectiveResponseBody(true, steps, null);
    expect(effectiveResponseBody).toBe(inventoryStep.capture.responseBody);
    expect(effectiveResponseBody).not.toBe(drillDownStep.capture.responseBody);
  });

  it("the return-selected call and the shape-inferred call are the same step", () => {
    const returnSelected = selectReturnAction(steps);
    const shapeInferenceBody = selectEffectiveResponseBody(true, steps, null);
    expect(shapeInferenceBody).toBe(returnSelected!.capture.responseBody);
    expect(shapeInferenceBody).toBe(inventoryStep.capture.responseBody);
  });

  it("falls back to the replay body for a non-submission (single-endpoint) flow", () => {
    const replayBody = { single: true };
    expect(selectEffectiveResponseBody(false, steps, replayBody)).toBe(replayBody);
  });

  it("shape inference fed the selected body emits inventory keys, not drill-down keys", () => {
    const effectiveResponseBody = selectEffectiveResponseBody(true, steps, null);
    const source = emitContractTs({
      siteId: "test-site",
      pascal: "TestSite",
      baseUrl: "https://api.example.com",
      baseHeaders: { "Content-Type": "application/json" },
      minTime: 100,
      safeRps: 10,
      responseBody: effectiveResponseBody,
      gql: false,
      gqlQuery: null,
      endpointPath: "/api/available-products",
      auxFiles: [],
      // multiStepBody intentionally unset: exercises inferZodSchema directly
      // on the selected body, decoupled from the multi-step z.unknown() gate
      // (see module doc comment above).
    });

    expect(source).toContain("totalAvailableListings");
    expect(source).toContain("products");
    expect(source).not.toContain("units");
    expect(source).not.toContain("exchangeRate");
  });

  it("the real multi-step path also infers the schema from the selected body", () => {
    const effectiveResponseBody = selectEffectiveResponseBody(true, steps, null);
    const source = emitContractTs({
      siteId: "test-site",
      pascal: "TestSite",
      baseUrl: "https://api.example.com",
      baseHeaders: { "Content-Type": "application/json" },
      minTime: 100,
      safeRps: 10,
      responseBody: effectiveResponseBody,
      gql: false,
      gqlQuery: null,
      endpointPath: "/api/available-products",
      auxFiles: [],
      // multiStepBody set, exactly as the real submission-flow path always
      // sets it — the selected body's shape reaches the emitted schema/type.
      multiStepBody: `    return { data: r3 };`,
    });

    expect(source).not.toContain("const TestSiteResponseSchema = z.unknown();");
    expect(source).toContain("totalAvailableListings");
  });
});
