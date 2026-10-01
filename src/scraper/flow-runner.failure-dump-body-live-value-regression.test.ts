import { Window } from "happy-dom";
import { describe, expect, it } from "vitest";

import { filterCompletedFromReplan, type NormalizedStep } from "@/scripts/recon-browser";

/**
 * Evaluates the literal capture expression used at the probe-absent and
 * cascade-exhaust failure-dump sites (flow-runner.ts's `bodyOuterHtmlRaw`
 * evaluate) against a happy-dom document, mirroring exactly what a real
 * `page.evaluate("document.body ? document.body.outerHTML : null")` returns
 * in a browser: the serialized CONTENT ATTRIBUTE, never the live `.value`
 * IDL property.
 */
function captureBodyOuterHtml(window: Window): string {
  const { document } = window;
  return document.body ? document.body.outerHTML : "";
}

describe("flow-runner failure-dump body capture vs. a live-typed field", () => {
  it("document.body.outerHTML never reflects a live .value set without a matching attribute", () => {
    const window = new Window();
    window.document.body.innerHTML =
      '<label for="otp">Confirmation Code</label><input id="otp" name="otp" type="text" />';
    const input = window.document.getElementById("otp") as unknown as {
      value: string;
    };
    // Simulates a user typing (or a DOM-direct fill setting `el.value = ...`):
    // the live IDL property changes, the markup `value=` attribute does not.
    input.value = "482913";

    const bodyOuterHtml = captureBodyOuterHtml(window);

    expect(bodyOuterHtml).not.toContain("482913");
    expect(bodyOuterHtml).toContain('<input id="otp" name="otp" type="text"');
  });

  it("filterCompletedFromReplan treats a live-filled field as stale because resolveFieldElementValue reparses the markup-only capture", () => {
    const window = new Window();
    window.document.body.innerHTML =
      '<label for="otp">Confirmation Code</label><input id="otp" name="otp" type="text" />';
    const input = window.document.getElementById("otp") as unknown as {
      value: string;
    };
    input.value = "482913";

    const bodyOuterHtmlAtFailure = captureBodyOuterHtml(window);

    const fillInstruction = "fill the 'Confirmation Code' field with '482913'";
    const mkStep = (instruction: string): NormalizedStep => ({
      instruction,
      optional: false,
      upload: false,
      origin: "replan",
    });
    const result = filterCompletedFromReplan(
      [mkStep(fillInstruction)],
      [fillInstruction],
      "click the 'Continue' button",
      bodyOuterHtmlAtFailure
    );

    // The field genuinely holds "482913" live, so a sound replan filter would
    // keep the fill dropped as already-done. Because the capture mechanism
    // only ever sees the empty markup attribute, it resolves the field's
    // value as "" at failure time, judges the completed fill "stale" (its
    // intended value "482913" != the reparsed "" ), and re-surfaces the step
    // — reproducing the report's phantom-submit symptom via this candidate
    // mechanism in isolation.
    expect(result.map((s) => s.instruction)).toContain(fillInstruction);
  });
});
