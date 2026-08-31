import { describe, expect, it } from "vitest";

import { injectCaptchaTokenAndSubmit } from "@/scraper/flow-runner";
import type { FrameTarget } from "@/scraper/frame-target";

/**
 * Fake in-memory page for `injectCaptchaTokenAndSubmit`, modeled on
 * `flow-runner.disabled-submit-click-acceptance.test.ts`'s
 * `makeOnboardingPage` (a stringified-expression fake rather than a real DOM),
 * but tuned for this primitive's single evaluate call: it decodes the
 * JSON-embedded `responseField`/`token` literals out of the expression text
 * and applies them to an in-memory generic onboarding-form state, so the test
 * proves the primitive's hand-off contract (field write + submit, no widget
 * callback) without depending on any named site's field names or sitekey.
 */
interface OnboardingFormState {
  fieldValue: string | null;
  changeDispatched: boolean;
  submitCount: number;
}

function makeOnboardingTarget(state: OnboardingFormState): FrameTarget {
  return {
    frame: {} as FrameTarget["frame"],
    frameSelector: null,
    evaluate: (async (expr: unknown) => {
      const src = String(expr);
      const responseFieldMatch = /const responseField = "([^"]+)"/.exec(src);
      const tokenMatch = /const token = "([^"]+)"/.exec(src);
      const responseField = responseFieldMatch?.[1];
      const token = tokenMatch?.[1];
      if (!responseField || !token) {
        throw new Error(`unrecognized inject-and-submit expression: ${src}`);
      }
      if (responseField !== "h-captcha-response") {
        throw new Error(`unexpected response field: ${responseField}`);
      }
      state.fieldValue = token;
      state.changeDispatched = true;
      state.submitCount += 1;
      return { injected: true, submitted: true };
    }) as FrameTarget["evaluate"],
    locator: () => ({ scope: "frame" as const }) as never,
    url: () => Promise.resolve("https://apply.example-onboarding.example.com/profile"),
    title: () => Promise.resolve("onboarding form"),
  };
}

describe("flow-runner/injectCaptchaTokenAndSubmit (inject-and-submit primitive)", () => {
  it("writes the fixture token into the response field and submits its form exactly once", async () => {
    const state: OnboardingFormState = {
      fieldValue: null,
      changeDispatched: false,
      submitCount: 0,
    };
    let evaluateCalls = 0;
    const target = makeOnboardingTarget(state);
    const countingTarget: FrameTarget = {
      ...target,
      evaluate: (async (expr: unknown) => {
        evaluateCalls += 1;
        return (target.evaluate as (e: unknown) => Promise<unknown>)(expr);
      }) as FrameTarget["evaluate"],
    };

    const result = await injectCaptchaTokenAndSubmit(countingTarget, "fixture-solved-token");

    expect(state.fieldValue).toBe("fixture-solved-token");
    expect(state.changeDispatched).toBe(true);
    expect(state.submitCount).toBe(1);
    expect(result).toEqual({ injected: true, submitted: true });
    // A single evaluate call performs the field write and the submit itself —
    // the primitive never needs to invoke the widget's own render callback
    // (which, per the widget contract, already calls form.submit() on its own).
    expect(evaluateCalls).toBe(1);
  });
});
