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

  it("judges the n+16 fallback click with the retry-resolved element's flag", () => {
    const argLists = calls.map((call) => call.slice(0, call.indexOf("})")));
    const retryArgs = argLists.filter((args) =>
      args.includes("elementSubmitShaped: retryResolvedElementIsSubmitShaped"),
    );
    expect(retryArgs.length).toBeGreaterThanOrEqual(2);
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
