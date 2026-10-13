import { describe, expect, it } from "vitest";
import { classifyStepSubmitIntent } from "@/scraper/flow-runner";
import {
  isSubmitShapedInstructionText,
  seedSubmitStepFromOwnInstructionText,
} from "@/scripts/recon-browser";

const DECLARED_NON_SUBMIT = [
  "On the checkout summary, click the 'Details' tab to view the price breakdown. Do NOT click 'Pay' or any control that proceeds to checkout.",
  "Expand the 'Fees' accordion on the checkout page. Do NOT click 'Reserve', 'Book Now', or 'Submit'.",
];

const REAL_SUBMIT = [
  "Click 'Submit' to send the form. Do NOT click 'Cancel'.",
  "Place the order. Do NOT click 'Pay again' or reload the page.",
  "Complete the application. Do NOT click 'Pay' twice.",
];

describe("flow-load submit seeding agrees with the declared-intent classifier", () => {
  it.each(DECLARED_NON_SUBMIT)("never seeds submitStep onto: %s", (instruction) => {
    expect(classifyStepSubmitIntent(instruction)).toBe("non-submit");
    expect(isSubmitShapedInstructionText(instruction)).toBe(false);
    const [seeded] = seedSubmitStepFromOwnInstructionText([
      { instruction, optional: true } as never,
    ]);
    expect(seeded?.submitStep).not.toBe(true);
  });

  it.each(REAL_SUBMIT)("still seeds a positive submit step with a guardrail: %s", (instruction) => {
    expect(classifyStepSubmitIntent(instruction)).toBe("submit");
    expect(isSubmitShapedInstructionText(instruction)).toBe(true);
  });
});
