import { describe, expect, it } from "vitest";
import { resolvedActionNamesStepTarget } from "./flow-runner.js";

describe("resolvedActionNamesStepTarget", () => {
  const step = "Click the 'Application Questions' heading";
  it("rejects an unrelated control", () => {
    expect(resolvedActionNamesStepTarget(step, { description: "language menu button" })).toBe(
      false
    );
  });
  it("accepts the named heading", () => {
    expect(
      resolvedActionNamesStepTarget(step, { description: "Application Questions heading" })
    ).toBe(true);
  });
  it("exempts value-quoting steps", () => {
    expect(
      resolvedActionNamesStepTarget("Fill the 'Email' field with 'a@b.com'", { description: "x" })
    ).toBe(true);
    expect(
      resolvedActionNamesStepTarget("Select 'Yes' from the 'Authorized' dropdown", {
        description: "x",
      })
    ).toBe(true);
    expect(
      resolvedActionNamesStepTarget("Click the 'Yes' radio button for the 'Are you 18?' question", {
        description: "x",
      })
    ).toBe(true);
  });
  it("with requireNamedControl, treats an opaque description as no contradiction", () => {
    const controlStep = "Click the 'Create account' button";
    expect(
      resolvedActionNamesStepTarget(
        controlStep,
        { description: "go" },
        { requireNamedControl: true }
      )
    ).toBe(true);
    expect(
      resolvedActionNamesStepTarget(
        controlStep,
        { description: "language menu button" },
        { requireNamedControl: true }
      )
    ).toBe(false);
  });
  it("with requireNamedControl, keeps the strict check for a non-interactive target", () => {
    const targetless =
      "Click on the 'Application Questions' page heading (an empty, non-interactive spot)";
    expect(
      resolvedActionNamesStepTarget(
        targetless,
        { description: "page heading" },
        { requireNamedControl: true }
      )
    ).toBe(false);
  });
});
