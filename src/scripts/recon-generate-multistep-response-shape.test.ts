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
 * `selectEffectiveResponseBody` is the extracted call-site helper (mirroring
 * `selectReturnAction`'s own extraction) that delegates to
 * `selectReturnAction`, guaranteeing the two selections structurally cannot
 * drift apart.
 *
 * CAVEAT: for multi-step flows the emitted response SCHEMA is hardcoded to
 * `z.unknown()` regardless of the selected body (recon-generate.ts:2512,
 * gated on `multiStepBody` truthiness — a deliberate author-contract
 * hand-off, not a bug; see recon-generate.ts:2473-2478). So on the real
 * generation path the selected body never reaches the emitted schema OR the
 * `z.infer`-derived response type today. This is proven below via
 * `emitContractTs` with `multiStepBody` set, exactly as the real submission-
 * flow path always sets it. The observable-shape assertion therefore drives
 * `emitContractTs` with `multiStepBody` UNSET, isolating `inferZodSchema` on
 * the selected body — asserting through the real gated path would be
 * vacuous (masked by z.unknown()).
 */
describe("recon-generate — G1 shape-inference target agrees with the return target", () => {
  const steps: MulticallFixtureStep[] = buildMulticallHeterogeneousActionStepsWithDrillDown();
  // selectReturnAction/selectEffectiveResponseBody pick the MOST RECENT
  // re-queried instance — r3 (page 2), not r2 (page 1) — as the freshest
  // answer from the flow's subject.
  const inventoryStep = steps[3]!; // r3: available-products/, page 2
  const drillDownStep = steps[4]!; // r4: available-sailings/ terminal drill-down

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

    expect(source).toContain("totalAvailableCruises");
    expect(source).toContain("products");
    expect(source).not.toContain("sailings");
    expect(source).not.toContain("exchangeRate");
  });

  it("documents that the real multi-step path masks the selection behind z.unknown() today", () => {
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
      // multiStepBody set (as the real submission-flow path always does) —
      // the selected body's shape does NOT reach the emitted schema/type.
      multiStepBody: `    return { data: r3 };`,
    });

    expect(source).toContain("const TestSiteResponseSchema = z.unknown();");
    expect(source).not.toContain("totalAvailableCruises");
  });
});
