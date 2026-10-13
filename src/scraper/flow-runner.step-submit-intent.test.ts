import { describe, expect, it } from "vitest";

import { classifyStepSubmitIntent, isStepSubmitShaped } from "@/scraper/flow-runner";

const NEG =
  "Do NOT click 'Book Now', 'Reserve', 'Select', or any control that proceeds to checkout";

describe("scraper/flow-runner classifyStepSubmitIntent", () => {
  it("classifies an explicit negated-proceed declaration as non-submit", () => {
    expect(classifyStepSubmitIntent(`Open the listing on example.com. ${NEG}`)).toBe("non-submit");
    expect(classifyStepSubmitIntent(NEG)).toBe("non-submit");
  });

  it("recognizes differently worded negated-submit guardrails", () => {
    for (const text of [
      "Click the Next control. Do not proceed to payment",
      "Click the 'Continue' tab. Do not proceed to the payment page.",
      "Open the details tab; never submit the order",
      "Expand the section. This is not a submit click",
      "Expand the section without submitting the form",
      "Click the tab. Do not place the order",
      "Click it. Avoid anything that leads to checkout",
      "Click the tab. Do not click Buy Now or anything that charges the card",
      "Click the tab. Do not click any control that advances the booking",
      "Click the tab. Don't advance to the next page",
    ]) {
      expect(classifyStepSubmitIntent(text)).toBe("non-submit");
    }
    expect(classifyStepSubmitIntent("Submit the form. Do not submit twice")).toBe("submit");
  });

  it("declares non-submit when a negated clause names a purchase-action control", () => {
    for (const text of [
      "Do NOT click Book Now",
      "Click the first date. Do NOT click 'Book Now' or 'Reserve'.",
      "Do NOT click 'Reserve', 'Book Now', 'Pay', or anything that proceeds past item selection",
      "Do NOT click 'Add to Cart' or 'Buy Now'",
    ]) {
      expect(classifyStepSubmitIntent(text)).toBe("non-submit");
    }
    expect(classifyStepSubmitIntent("Click Submit. Do NOT click Cancel.")).toBe("submit");
    expect(
      classifyStepSubmitIntent("Click the Submit button to submit the order. Do NOT click Reserve.")
    ).toBe("submit");
    expect(classifyStepSubmitIntent("Read the Reserved seating note")).toBe("unspecified");
  });

  it("classifies a click-submit instruction as submit", () => {
    expect(classifyStepSubmitIntent("click submit")).toBe("submit");
  });

  it("keeps submit when a guardrail is unrelated or the submit phrase is outside the negation", () => {
    expect(classifyStepSubmitIntent("Click submit. Do not click cancel.")).toBe("submit");
    expect(classifyStepSubmitIntent("Click submit. Do not submit twice")).toBe("submit");
  });

  it("returns unspecified for plain or bare-negation instructions", () => {
    expect(classifyStepSubmitIntent("Fill the name field")).toBe("unspecified");
    expect(classifyStepSubmitIntent(null)).toBe("unspecified");
  });
});

describe("scraper/flow-runner isStepSubmitShaped", () => {
  it("keeps an explicit submitStep authoritative over a non-submit instruction", () => {
    expect(
      isStepSubmitShaped({
        step: NEG,
        submitStep: true,
        isFinalStep: true,
        flowHasSubmitSemantics: true,
      })
    ).toBe(true);
  });

  it("vetoes final-step inference when the instruction declares non-submit", () => {
    expect(
      isStepSubmitShaped({
        step: NEG,
        submitStep: false,
        isFinalStep: true,
        flowHasSubmitSemantics: true,
      })
    ).toBe(false);
  });

  it("infers submit from final step with flow semantics, or from submit wording", () => {
    expect(
      isStepSubmitShaped({
        step: "Review",
        submitStep: false,
        isFinalStep: true,
        flowHasSubmitSemantics: true,
      })
    ).toBe(true);
    expect(
      isStepSubmitShaped({
        step: "click submit",
        submitStep: false,
        isFinalStep: false,
        flowHasSubmitSemantics: false,
      })
    ).toBe(true);
    expect(
      isStepSubmitShaped({
        step: "Review",
        submitStep: false,
        isFinalStep: true,
        flowHasSubmitSemantics: false,
      })
    ).toBe(false);
  });
});

describe("scraper/flow-runner verbatim non-submit guardrail steps", () => {
  const STEPS = [
    "In the pricing panel for the selected date, click on a category tab or link (e.g. 'Basic' or 'Premium') to view that category's price. Do NOT click 'Book Now', 'Reserve', 'Select', or any control that proceeds to checkout.",
    "Click the 'Continue' control that opens that item's own detail page. This is the selection view showing 'from $' prices; it is NOT checkout. Do NOT click 'Reserve', 'Book Now', 'Pay', 'Continue to Guest Info', or anything that proceeds past selection.",
    "On the detail page, click the 'Premium' type card to expand its sub-categories and their prices. Do NOT click 'Reserve', 'Book Now', 'Pay', or anything that proceeds past selection.",
  ];

  it("classifies each guardrail step as non-submit", () => {
    for (const step of STEPS) {
      expect(classifyStepSubmitIntent(step)).toBe("non-submit");
    }
  });

  it("resolves each guardrail step to not submit-shaped even as the final step", () => {
    for (const step of STEPS) {
      expect(
        isStepSubmitShaped({
          step,
          submitStep: false,
          isFinalStep: true,
          flowHasSubmitSemantics: true,
        })
      ).toBe(false);
    }
  });

  it("still resolves a genuine submit step to submit", () => {
    const step = "Click Submit to place the order";
    expect(classifyStepSubmitIntent(step)).toBe("submit");
    expect(
      isStepSubmitShaped({
        step,
        submitStep: false,
        isFinalStep: false,
        flowHasSubmitSemantics: false,
      })
    ).toBe(true);
  });
});
