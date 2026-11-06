import { describe, expect, it, vi } from "vitest";

import { executeStepWithHealing, isPassiveNoopStep } from "@/scraper/flow-runner";

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

describe("executeStepWithHealing — passive step dispatch", () => {
  it("returns completed without touching the page or stagehand", async () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const page = { url: () => "https://x.example.com/", evaluate: vi.fn() };
    const trajectory: unknown[] = [];
    const outcome = await executeStepWithHealing({
      stagehand: {},
      page,
      step: "Do not click anything; just wait for the list to settle",
      optional: false,
      upload: false,
      submitStep: false,
      captchaGated: false,
      stepIndex: 0,
      totalSteps: () => 1,
      trajectory,
      logger,
    } as never);
    expect(outcome).toBe("completed");
    expect(trajectory).toEqual([{ stepIndex: 0, verifiedBy: "dom" }]);
    expect(page.evaluate).not.toHaveBeenCalled();
  });
});
