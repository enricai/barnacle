import { describe, expect, it } from "vitest";

import { shouldRetryCaptchaRegistry } from "@/scraper/flow-runner";

/**
 * Pins the retry-gate decision for the two ways the callback-capture
 * registry can be empty: the wrap never installed at all ("empty"/"absent",
 * an attach-timing race a retry can still fix) versus the wrap installing
 * AFTER hcaptcha.render already fired for this sitekey/widgetId
 * ("renderedUnmatched", window.hcaptcha loaded and a widget rendered, but no
 * matching registry entry). Per the recon evidence behind this detection
 * (three retry attempts all observed registryState=empty with no callback
 * ever discovered), reinstalling the wrap and retrying the same
 * install-then-poll strategy can never recapture a render() call that has
 * already returned — so unlike the never-installed race, this state must
 * gate the loop to give up rather than burn the retry budget on a doomed
 * strategy.
 */
describe("shouldRetryCaptchaRegistry — late-install-after-render vs never-installed registry states", () => {
  it("retries the never-installed race (registryState=empty) within budget", () => {
    expect(shouldRetryCaptchaRegistry(1, 3, "empty", false, false)).toBe(true);
  });

  it("does not retry the late-install-after-render race (registryState=renderedUnmatched), even on the first attempt", () => {
    expect(shouldRetryCaptchaRegistry(1, 3, "renderedUnmatched", false, false)).toBe(false);
  });

  it("distinguishes the two empty-registry causes: same attempt/budget/callback/confirmed inputs, opposite decisions", () => {
    const args = [1, 3, "empty", false, false] as const;
    const renderedUnmatchedArgs = [1, 3, "renderedUnmatched", false, false] as const;
    expect(shouldRetryCaptchaRegistry(...args)).not.toBe(
      shouldRetryCaptchaRegistry(...renderedUnmatchedArgs)
    );
  });

  it("still gives up on renderedUnmatched even with attempts remaining well under the bound", () => {
    expect(shouldRetryCaptchaRegistry(1, 5, "renderedUnmatched", false, false)).toBe(false);
  });
});
