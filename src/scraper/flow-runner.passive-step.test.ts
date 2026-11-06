import { describe, expect, it } from "vitest";

import { isPassiveNoopStep } from "@/scraper/flow-runner";

describe("isPassiveNoopStep", () => {
  it("wait/do-not-click step is passive", () => {
    expect(isPassiveNoopStep("Do not click anything; just wait for the list to settle")).toBe(true);
    expect(isPassiveNoopStep("Wait for the results to load")).toBe(true);
  });
  it("real click steps are not passive", () => {
    expect(isPassiveNoopStep("Click the Next button")).toBe(false);
    expect(isPassiveNoopStep("Fill in the 'Email' field")).toBe(false);
  });
  it("negated target with another positive action still acts", () => {
    expect(isPassiveNoopStep("Do not click Delete; click the Save button")).toBe(false);
    expect(isPassiveNoopStep("Wait for the spinner, then click Next")).toBe(false);
  });
  it("empty is not passive", () => {
    expect(isPassiveNoopStep("")).toBe(false);
  });
});
