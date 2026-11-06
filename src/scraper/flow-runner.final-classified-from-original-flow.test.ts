import { describe, expect, it } from "vitest";

import { flowHasSubmitSemantics, isGenuineFinalSubmit } from "@/scraper/flow-runner";

const opts = { submitEndpointPattern: null, requireSubmitEndpointMatch: false };

describe("final-submit classification derives from the original flow", () => {
  const original = [
    { submitStep: false },
    { submitStep: true }, // mid-flow flagged submit
    { submitStep: false },
  ];

  it("keeps a mid-flow flagged submit non-final when the original flow ends elsewhere", () => {
    const flowSubmit = flowHasSubmitSemantics({ steps: original, ...opts });
    expect(flowSubmit).toBe(false);
    // A replan leaving the flagged step in the last slot of the span: the
    // flow-level flag was computed from the original list, so it stays mid-flow.
    expect(isGenuineFinalSubmit({ isFinalStep: true, flowHasSubmitSemantics: flowSubmit })).toBe(
      false
    );
  });

  it("keeps a genuinely last flagged submit strict", () => {
    const flowSubmit = flowHasSubmitSemantics({
      steps: [{ submitStep: false }, { submitStep: true }],
      ...opts,
    });
    expect(flowSubmit).toBe(true);
    expect(isGenuineFinalSubmit({ isFinalStep: true, flowHasSubmitSemantics: flowSubmit })).toBe(
      true
    );
  });
});
