import { describe, expect, it } from "vitest";
import { widgetLabelMatches } from "./flow-runner";

const Q =
  "Have you or any organization for which you were employed ever been excluded from the Medicare or other federal or state health care programs?";

describe("widgetLabelMatches with a long question", () => {
  it("does not match a short label contained in the question", () => {
    expect(widgetLabelMatches("State", Q)).toBe(false);
    expect(widgetLabelMatches("Address", Q)).toBe(false);
  });
  it("matches the full label", () => {
    expect(widgetLabelMatches(Q, Q)).toBe(true);
  });
});
