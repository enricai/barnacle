import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { isMidFlowSubmitShapedStep } from "@/scraper/flow-runner";

/**
 * The deep-submit runner-up and child-frame fallback must treat an
 * element-inferred mid-flow submit exactly as the primary click does, so every
 * `isMidFlowSubmitShapedStep` call site has to build `elementSubmitShaped`.
 */
describe("isMidFlowSubmitShapedStep call-site parity", () => {
  const source = readFileSync(resolve(__dirname, "flow-runner.ts"), "utf8");
  const calls = source.split("isMidFlowSubmitShapedStep({").slice(1);

  it("passes elementSubmitShaped at every call site", () => {
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      const args = call.slice(0, call.indexOf("})"));
      expect(args).toContain("elementSubmitShaped");
    }
  });

  it("treats an element-inferred submit as mid-flow, never as genuine final", () => {
    const base = {
      step: "Continue",
      submitStep: false,
      isFinalStep: false,
      flowHasSubmitSemantics: true,
    };
    expect(isMidFlowSubmitShapedStep({ ...base, elementSubmitShaped: true })).toBe(true);
    expect(
      isMidFlowSubmitShapedStep({ ...base, isFinalStep: true, elementSubmitShaped: true }),
    ).toBe(false);
  });
});
