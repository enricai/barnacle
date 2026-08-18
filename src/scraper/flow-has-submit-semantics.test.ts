import { describe, expect, it } from "vitest";

import { flowHasSubmitSemantics } from "@/scraper/flow-runner";

describe("scraper/flow-runner flowHasSubmitSemantics", () => {
  it("returns false when no step submits and no submit-endpoint shape is declared (royalcaribbean-style read-only flow)", () => {
    const result = flowHasSubmitSemantics({
      steps: [{ submitStep: false }, { submitStep: false }],
      submitEndpointPattern: null,
      requireSubmitEndpointMatch: false,
    });

    expect(result).toBe(false);
  });

  it("returns true when any step declares submitStep:true", () => {
    const result = flowHasSubmitSemantics({
      steps: [{ submitStep: false }, { submitStep: true }],
      submitEndpointPattern: null,
      requireSubmitEndpointMatch: false,
    });

    expect(result).toBe(true);
  });

  it("returns true when submitEndpointPattern is non-null even with no submitStep", () => {
    const result = flowHasSubmitSemantics({
      steps: [{ submitStep: false }],
      submitEndpointPattern: "/api/submit",
      requireSubmitEndpointMatch: false,
    });

    expect(result).toBe(true);
  });

  it("returns true when requireSubmitEndpointMatch is true alone", () => {
    const result = flowHasSubmitSemantics({
      steps: [{ submitStep: false }],
      submitEndpointPattern: null,
      requireSubmitEndpointMatch: true,
    });

    expect(result).toBe(true);
  });

  it("returns false for an empty step list with no submit shape", () => {
    const result = flowHasSubmitSemantics({
      steps: [],
      submitEndpointPattern: null,
      requireSubmitEndpointMatch: false,
    });

    expect(result).toBe(false);
  });
});
