import type { Action } from "@browserbasehq/stagehand";
import { describe, expect, it, vi } from "vitest";

import { verifyDomEffect } from "@/scraper/flow-runner";
import type { FrameTarget } from "@/scraper/frame-target";

/**
 * Regression coverage for the fill/type branch of `verifyDomEffect`: masked/
 * formatted inputs (e.g. a phone field displaying "(212) 555-0123" after
 * typing "2125550123") must still verify as a hit once the raw substring
 * check is normalized against punctuation/whitespace differences.
 */

function makeTarget(inputValue: string): FrameTarget {
  return {
    frame: {} as FrameTarget["frame"],
    frameSelector: null,
    evaluate: vi.fn().mockResolvedValue(null) as FrameTarget["evaluate"],
    locator: (() => ({
      first: () => ({
        inputValue: vi.fn().mockResolvedValue(inputValue),
        fill: vi.fn().mockResolvedValue(undefined),
        type: vi.fn().mockResolvedValue(undefined),
      }),
    })) as FrameTarget["locator"],
    url: () => Promise.resolve("https://example.com/apply"),
    title: () => Promise.resolve("Apply"),
  };
}

const fillAction = (value: string): Action =>
  ({
    selector: "xpath=//input[@id='phone']",
    description: "Phone number",
    method: "fill",
    arguments: [value],
  }) as Action;

describe("flow-runner/verifyDomEffect — masked input normalization", () => {
  it("verifies a hit when the masked/reformatted value contains the typed digits", async () => {
    const target = makeTarget("(212) 555-0123");

    const hit = await verifyDomEffect(target, fillAction("2125550123"));

    expect(hit).toBe(true);
  });

  it("still returns false for a genuinely wrong value", async () => {
    const target = makeTarget("(212) 555-9999");

    const hit = await verifyDomEffect(target, fillAction("2125550123"));

    expect(hit).toBe(false);
  });

  it("still verifies an exact raw-substring match (unformatted input)", async () => {
    const target = makeTarget("2125550123");

    const hit = await verifyDomEffect(target, fillAction("2125550123"));

    expect(hit).toBe(true);
  });
});
