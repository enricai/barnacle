import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Page, Stagehand } from "@browserbasehq/stagehand";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

process.env.RECON_RUN_ID = "flow-runner-captcha-gated-submit-hook-test";
process.env.RECON_OUT_DIR = mkdtempSync(join(tmpdir(), "recon-captcha-gated-submit-hook-"));

const { solveCaptchaMock } = vi.hoisted(() => ({ solveCaptchaMock: vi.fn() }));
vi.mock("@/scraper/captcha-solver", () => ({ solveCaptcha: solveCaptchaMock }));

import { CaptchaSolverUnavailableError } from "@/scraper/errors";
import { executeStepWithHealing } from "@/scraper/flow-runner";
import { resolveReconRunDir } from "@/scripts/recon-shared";
import type { Logger } from "@/types/logging";

/**
 * Exercises the captchaGated hook wired into `executeStepWithHealing`: on a
 * submit/final-shaped step marked `captchaGated: true`, it reads the sitekey
 * off the (fake) page, calls the mocked `solveCaptcha`, invokes the real
 * `injectCaptchaTokenAndSubmit` primitive against a fake DOM, and reports
 * completion once the widened `waitForTransitionBody` poll confirms a real
 * transition. A `captchaGated` step with no `[data-sitekey]` widget or with
 * the flag unset falls through untouched; a solver-unavailable rejection
 * fails the step instead of silently passing.
 */

const testLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

interface FakeField {
  value: string;
  dispatched: string[];
}

/** Minimal fake `<form>`/hCaptcha-widget DOM + Stagehand `Page`, driven entirely through `page.evaluate`. */
function makeFakePage(opts: { hasSitekey: boolean; callbackName?: string }): {
  page: Page;
  field: FakeField;
  submitCount: { n: number };
  callbackInvokedWith: { token: string | null };
} {
  const field: FakeField = { value: "", dispatched: [] };
  const submitCount = { n: 0 };
  const callbackInvokedWith: { token: string | null } = { token: null };

  const evaluate = vi.fn().mockImplementation(async (expr: unknown) => {
    const src = String(expr);
    // injectCaptchaTokenAndSubmit's precheck expr is keyed on "hasForm", its
    // unique return shape, and now also discovers a widget's data-callback:
    // when opts.callbackName is set the precheck reports it, which routes to
    // a callback-invoke expr (keyed on "window[") INSTEAD of the set-value
    // (unmatched, discarded) + dispatch-only expr (keyed on "dispatchEvent")
    // fallback pair. submitCaptchaGatedForm's explicit fallback submit expr
    // is keyed on "requestSubmit" (its now-preferred call), not the bare
    // "form.submit()" it falls back to only when requestSubmit is absent.
    // The set-only expr also contains "data-sitekey" (its form-preference
    // logic), so the sitekey-read branch below must be checked via its more
    // specific "getAttribute" marker, and the set-only branch must be
    // checked before the generic "data-sitekey" branch.
    // Run against a bare fake DOM instead of re-deriving the exact expr string
    // (mirrors flow-runner.captcha-inject-submit.test.ts's technique,
    // simplified since that primitive already has its own dedicated unit tests).
    if (src.includes("hasForm")) {
      return { injected: true, hasForm: true, callbackDiscovered: Boolean(opts.callbackName) };
    }
    if (src.includes("window[")) {
      callbackInvokedWith.token = "solved-token";
      return undefined;
    }
    if (src.includes("dispatchEvent")) {
      field.value = "solved-token";
      field.dispatched.push("change");
      return undefined;
    }
    if (src.includes("requestSubmit")) {
      submitCount.n += 1;
      return undefined;
    }
    if (src.includes("getAttribute")) {
      return opts.hasSitekey
        ? { siteKey: "10000000-ffff-ffff-ffff-000000000001", isInvisible: true }
        : { siteKey: null, isInvisible: false };
    }
    if (src === "navigator.userAgent") return "test-agent/1.0";
    if (src.includes("outerHTML")) return { html: 0, text: "0:" };
    if (src.includes("isInvalid(el)")) return 0;
    return null;
  });

  const page = {
    evaluate,
    url: () => "https://apply.example.com/application/abc-123",
    title: vi.fn().mockResolvedValue(""),
    locator: vi.fn().mockReturnValue({
      first: () => ({
        isChecked: vi.fn().mockResolvedValue(false),
        inputValue: vi.fn().mockResolvedValue(""),
      }),
    }),
    waitForTimeout: vi.fn().mockResolvedValue(undefined),
  } as unknown as Page;

  return { page, field, submitCount, callbackInvokedWith };
}

function baseParams(
  page: Page,
  stagehand: Stagehand,
  overrides: { captchaGated: boolean; advanceTransitionBodyPattern: string | null }
): Parameters<typeof executeStepWithHealing>[0] {
  return {
    stagehand,
    page,
    step: "Solve the captcha and submit the application",
    optional: false,
    upload: false,
    submitStep: true,
    captchaGated: overrides.captchaGated,
    flowHasSubmitSemantics: true,
    stepIndex: 0,
    phase: "apply",
    signalCounter: { n: 0 },
    recentCaptures: [] as string[],
    recentCaptureMeta: [] as { method: string; status: number; url: string }[],
    anthropic: null,
    rephraseModel: null,
    logger: testLogger,
    captureFn: vi.fn().mockResolvedValue(undefined),
    uploadFixture: null,
    isFinalStep: true,
    submitEndpointPattern: null,
    submittedStateSelectors: [] as string[],
    requireSubmitEndpointMatch: false,
    advanceTransitionBodyPattern: overrides.advanceTransitionBodyPattern,
    successUrlFragments: [] as string[],
    successPageTitleHints: [] as string[],
    ownBackendHostnames: [] as string[],
    knownErrorClassPrefixes: [] as string[],
    wizardExitButtonLabels: [] as string[],
  };
}

describe("flow-runner/executeStepWithHealing — captcha-gated submit hook", () => {
  let capturesDir: string;

  beforeAll(() => {
    capturesDir = resolveReconRunDir().graphqlDir;
  });

  beforeEach(() => {
    solveCaptchaMock.mockReset();
    rmSync(capturesDir, { recursive: true, force: true });
    mkdirSync(capturesDir, { recursive: true });
  });

  it("solves, injects the token, submits, and reports completed once the widened poll confirms the real transition already on disk", async () => {
    solveCaptchaMock.mockResolvedValue({ token: "solved-token", provider: "2captcha", ms: 12 });
    const { page, field, submitCount } = makeFakePage({ hasSitekey: true });
    // Written BEFORE the hook runs, so waitForTransitionBody's initial
    // (non-polling) check already matches it — proves the hook reuses the
    // EXISTING poll primitive rather than a new captcha-specific one, without
    // this test paying the real wall-clock cost of the widened budget.
    writeFileSync(
      join(capturesDir, "001-submit-real.json"),
      JSON.stringify({
        requestPostData: "type=next&step=review",
        variables: { input: { type: "next" } },
      })
    );
    const stagehand = {} as Stagehand;

    const result = await executeStepWithHealing(
      baseParams(page, stagehand, { captchaGated: true, advanceTransitionBodyPattern: "type=next" })
    );

    expect(result).toBe("completed");
    expect(solveCaptchaMock).toHaveBeenCalledWith({
      type: "hcaptcha",
      siteKey: "10000000-ffff-ffff-ffff-000000000001",
      pageUrl: "https://apply.example.com/application/abc-123",
      isInvisible: true,
      userAgent: "test-agent/1.0",
    });
    expect(field.value).toBe("solved-token");
    expect(field.dispatched).toEqual(["change"]);
    // The transition was already confirmed (written to disk before the hook
    // ran), so no explicit submit is issued — the widget's own callback (or,
    // in this fake, the pre-seeded capture) already accounted for the advance.
    expect(submitCount.n).toBe(0);
  });

  it("invokes a discoverable widget callback with the solved token instead of the set-value fallback, and never fires the explicit submit when the transition poll confirms via that path", async () => {
    solveCaptchaMock.mockResolvedValue({ token: "solved-token", provider: "2captcha", ms: 12 });
    const { page, field, submitCount, callbackInvokedWith } = makeFakePage({
      hasSitekey: true,
      callbackName: "onCaptchaSolved",
    });
    // Written BEFORE the hook runs, so waitForTransitionBody's initial
    // (non-polling) check already matches it — the confirmed transition here
    // is what the callback's own submit would have produced, not the
    // explicit fallback (which must stay at 0 throughout).
    writeFileSync(
      join(capturesDir, "001-submit-real.json"),
      JSON.stringify({
        requestPostData: "type=next&step=review",
        variables: { input: { type: "next" } },
      })
    );
    const stagehand = {} as Stagehand;

    const result = await executeStepWithHealing(
      baseParams(page, stagehand, { captchaGated: true, advanceTransitionBodyPattern: "type=next" })
    );

    expect(result).toBe("completed");
    expect(callbackInvokedWith.token).toBe("solved-token");
    // The callback path never touches the response field or dispatches
    // "change" — that's the set-value+dispatch fallback's job, exercised
    // only when no callback is discoverable (see the other cases above).
    expect(field.value).toBe("");
    expect(field.dispatched).toEqual([]);
    expect(submitCount.n).toBe(0);
  });

  it("issues exactly one explicit submit when the transition poll finds no matching capture", async () => {
    solveCaptchaMock.mockResolvedValue({ token: "solved-token", provider: "2captcha", ms: 12 });
    const { page, field, submitCount } = makeFakePage({ hasSitekey: true });
    // No capture is written, so waitForTransitionBody's initial check never
    // matches: the widget's own callback evidently didn't submit for us, so
    // the hook must issue exactly one explicit tolerant submit itself. Force
    // the poll's deadline to already be past on its first loop check so the
    // test doesn't pay the real widened (45s) captcha poll budget.
    const nowSpy = vi.spyOn(performance, "now");
    let calls = 0;
    nowSpy.mockImplementation(() => {
      calls += 1;
      return calls === 1 ? 0 : Number.POSITIVE_INFINITY;
    });
    const stagehand = {} as Stagehand;

    const result = await executeStepWithHealing(
      baseParams(page, stagehand, { captchaGated: true, advanceTransitionBodyPattern: "type=next" })
    ).catch(() => {
      // Falling through into the full cascade on this bare fake once the
      // captcha hook's own poll exhausts is expected to eventually fail;
      // only the pre-fallthrough submit count is under test here.
    });
    nowSpy.mockRestore();

    expect(result).not.toBe("completed");
    expect(field.value).toBe("solved-token");
    expect(submitCount.n).toBe(1);
  });

  it("resolves (never propagates) when the dispatch-only eval rejects with a navigation-shaped error", async () => {
    solveCaptchaMock.mockResolvedValue({ token: "solved-token", provider: "2captcha", ms: 12 });
    const { page, submitCount } = makeFakePage({ hasSitekey: true });
    (page.evaluate as ReturnType<typeof vi.fn>).mockImplementation(async (expr: unknown) => {
      const src = String(expr);
      if (src.includes("hasForm")) {
        return { injected: true, hasForm: true };
      }
      if (src.includes("dispatchEvent")) {
        throw new Error("Execution context was destroyed");
      }
      if (src.includes("requestSubmit")) {
        submitCount.n += 1;
        return undefined;
      }
      if (src.includes("getAttribute")) {
        return { siteKey: "10000000-ffff-ffff-ffff-000000000001", isInvisible: true };
      }
      if (src === "navigator.userAgent") return "test-agent/1.0";
      if (src.includes("outerHTML")) return { html: 0, text: "0:" };
      if (src.includes("isInvalid(el)")) return 0;
      return null;
    });
    writeFileSync(
      join(capturesDir, "001-submit-real.json"),
      JSON.stringify({
        requestPostData: "type=next&step=review",
        variables: { input: { type: "next" } },
      })
    );
    const stagehand = {} as Stagehand;

    const result = await executeStepWithHealing(
      baseParams(page, stagehand, { captchaGated: true, advanceTransitionBodyPattern: "type=next" })
    );

    expect(result).toBe("completed");
    // The transition was already confirmed (pre-seeded capture), so no
    // explicit submit is issued despite the dispatch-only eval's rejection.
    expect(submitCount.n).toBe(0);
    expect(testLogger.info).toHaveBeenCalledWith(
      expect.stringContaining("captchaGated step: token injected=true hasForm=true")
    );
  });

  it("resolves (never propagates) when the set-value-only eval rejects with a navigation-shaped error", async () => {
    solveCaptchaMock.mockResolvedValue({ token: "solved-token", provider: "2captcha", ms: 12 });
    const { page, field, submitCount } = makeFakePage({ hasSitekey: true });
    (page.evaluate as ReturnType<typeof vi.fn>).mockImplementation(async (expr: unknown) => {
      const src = String(expr);
      if (src.includes("hasForm")) {
        return { injected: true, hasForm: true };
      }
      if (src.includes("getAttribute")) {
        return { siteKey: "10000000-ffff-ffff-ffff-000000000001", isInvisible: true };
      }
      // The set-only expr also contains "data-sitekey" (its form-preference
      // logic) and must be checked here, after the more specific
      // "getAttribute" sitekey-probe branch above and the "hasForm"
      // precheck branch, so this throw lands on the set-value eval itself —
      // the one the recon doc's stack trace shows crashing — not the
      // sitekey probe or the precheck.
      if (src.includes("data-sitekey")) {
        throw new Error("Execution context was destroyed");
      }
      if (src.includes("dispatchEvent")) {
        field.value = "solved-token";
        field.dispatched.push("change");
        return undefined;
      }
      if (src.includes("requestSubmit")) {
        submitCount.n += 1;
        return undefined;
      }
      if (src === "navigator.userAgent") return "test-agent/1.0";
      if (src.includes("outerHTML")) return { html: 0, text: "0:" };
      if (src.includes("isInvalid(el)")) return 0;
      return null;
    });
    writeFileSync(
      join(capturesDir, "001-submit-real.json"),
      JSON.stringify({
        requestPostData: "type=next&step=review",
        variables: { input: { type: "next" } },
      })
    );
    const stagehand = {} as Stagehand;

    const result = await executeStepWithHealing(
      baseParams(page, stagehand, { captchaGated: true, advanceTransitionBodyPattern: "type=next" })
    );

    expect(result).toBe("completed");
    // The transition was already confirmed (pre-seeded capture), so no
    // explicit submit is issued despite the set-value-only eval's rejection.
    expect(submitCount.n).toBe(0);
    expect(testLogger.info).toHaveBeenCalledWith(
      expect.stringContaining("captchaGated step: token injected=true hasForm=true")
    );
  });

  it("falls through untouched (no solve call) when captchaGated is unset", async () => {
    solveCaptchaMock.mockResolvedValue({ token: "solved-token", provider: "2captcha", ms: 12 });
    const { page, submitCount } = makeFakePage({ hasSitekey: true });
    const stagehand = {} as Stagehand;

    await executeStepWithHealing(
      baseParams(page, stagehand, {
        captchaGated: false,
        advanceTransitionBodyPattern: "type=next",
      })
    ).catch(() => {
      // Falling through into the full cascade on this bare fake page/stagehand
      // is expected to eventually throw — only "the hook itself never ran" is
      // under test here.
    });

    expect(solveCaptchaMock).not.toHaveBeenCalled();
    expect(submitCount.n).toBe(0);
  });

  it("falls through untouched (no solve call) when the page has no [data-sitekey] widget", async () => {
    solveCaptchaMock.mockResolvedValue({ token: "solved-token", provider: "2captcha", ms: 12 });
    const { page, submitCount } = makeFakePage({ hasSitekey: false });
    const stagehand = {} as Stagehand;

    await executeStepWithHealing(
      baseParams(page, stagehand, { captchaGated: true, advanceTransitionBodyPattern: "type=next" })
    ).catch(() => {
      // Same rationale as above: cascade fallthrough is expected to fail on
      // this bare fake; only the "no sitekey => no solve call" gate is under test.
    });

    expect(solveCaptchaMock).not.toHaveBeenCalled();
    expect(submitCount.n).toBe(0);
  });

  it("does not report completed from the captchaGated block when the 45s transition poll never confirms a match, even though all three evals resolved", async () => {
    solveCaptchaMock.mockResolvedValue({ token: "solved-token", provider: "2captcha", ms: 12 });
    const { page, field, submitCount } = makeFakePage({ hasSitekey: true });
    // Real setTimeout-backed waitForTimeout so `vi.runAllTimersAsync()` can
    // actually drive the CAPTCHA_TRANSITION_POLL_MS (45s) interval loop
    // (mirrors flow-runner.submit-advance-transition-poll.test.ts's
    // "logs $expectedMs ms when captchaGated=$captchaGated" harness).
    (page.waitForTimeout as ReturnType<typeof vi.fn>).mockImplementation(
      (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
    );
    // Only a non-matching capture is ever written — the real "type=next"
    // transition body never lands, so the poll must run out its full window
    // and report unconfirmed rather than short-circuiting to "completed"
    // from injectResult.submitted (all three evals below resolve without
    // error, which is exactly what must NOT be trusted alone).
    writeFileSync(
      join(capturesDir, "001-submit-autosave-only.json"),
      JSON.stringify({ requestPostData: "type=autosave&field=x" })
    );
    const stagehand = {} as Stagehand;
    vi.useFakeTimers();

    const resultPromise = executeStepWithHealing(
      baseParams(page, stagehand, { captchaGated: true, advanceTransitionBodyPattern: "type=next" })
    ).catch(() => "not-completed" as const);
    await vi.runAllTimersAsync();
    const result = await resultPromise;
    vi.useRealTimers();

    expect(result).not.toBe("completed");
    // The evals still all resolved cleanly (token injected, form present) —
    // proving this is gated on the observed transition, not on the evals
    // returning without error.
    expect(field.value).toBe("solved-token");
    expect(field.dispatched).toEqual(["change"]);
    expect(testLogger.info).toHaveBeenCalledWith(
      expect.stringContaining("captchaGated step: post-submit transition poll confirmed=false")
    );
    // No transition was confirmed, so the explicit-submit fallback fires
    // exactly once (hasForm=true) — this test only asserts on the
    // completion gate itself, not on submit-count behavior.
    expect(submitCount.n).toBe(1);
  });

  it("throws CaptchaError (never falls through to the cascade) when no callback is discoverable and neither the inject nor the explicit fallback submit produces a confirmed transition", async () => {
    solveCaptchaMock.mockResolvedValue({ token: "solved-token", provider: "2captcha", ms: 12 });
    // No callbackName => callbackDiscovered=false; no capture is ever
    // written, so the post-inject poll AND the post-fallback-submit re-poll
    // both find nothing to confirm. Force performance.now() past the
    // deadline on the first check so the test doesn't pay either widened
    // (45s) poll's real wall-clock budget.
    const { page, field, submitCount } = makeFakePage({ hasSitekey: true });
    const nowSpy = vi.spyOn(performance, "now");
    let calls = 0;
    nowSpy.mockImplementation(() => {
      calls += 1;
      return calls === 1 ? 0 : Number.POSITIVE_INFINITY;
    });
    const stagehand = {} as Stagehand;

    await expect(
      executeStepWithHealing(
        baseParams(page, stagehand, {
          captchaGated: true,
          advanceTransitionBodyPattern: "type=next",
        })
      )
    ).rejects.toThrow(/no render-config callback could be found/);
    nowSpy.mockRestore();

    expect(field.value).toBe("solved-token");
    // The explicit fallback still fires exactly once (hasForm=true) before
    // the failure is surfaced — the fix doesn't skip the fallback, it just
    // stops trusting silence as success once the fallback also produces no
    // confirmed transition.
    expect(submitCount.n).toBe(1);
  });

  it("does not throw CaptchaError when no callback is discoverable but no advanceTransitionBodyPattern is configured (nothing to poll, cascade must still run)", async () => {
    solveCaptchaMock.mockResolvedValue({ token: "solved-token", provider: "2captcha", ms: 12 });
    const { page, field, submitCount } = makeFakePage({ hasSitekey: true });
    const stagehand = {} as Stagehand;

    const result = await executeStepWithHealing(
      baseParams(page, stagehand, { captchaGated: true, advanceTransitionBodyPattern: null })
    ).catch(() => "cascade-fallthrough" as const);

    // With no pattern configured, no poll ever runs, so the new CaptchaError
    // guard must stay dormant and this falls through to the normal cascade
    // (which is expected to eventually fail on this bare fake page/stagehand,
    // but NOT via a thrown CaptchaError about a missing callback).
    expect(result).toBe("cascade-fallthrough");
    expect(field.value).toBe("solved-token");
    expect(submitCount.n).toBe(1);
  });

  it("fails the step (never silently proceeds) when solveCaptcha rejects with the unavailable error", async () => {
    solveCaptchaMock.mockRejectedValue(new CaptchaSolverUnavailableError());
    const { page, submitCount } = makeFakePage({ hasSitekey: true });
    const stagehand = {} as Stagehand;

    await expect(
      executeStepWithHealing(
        baseParams(page, stagehand, {
          captchaGated: true,
          advanceTransitionBodyPattern: "type=next",
        })
      )
    ).rejects.toThrow(CaptchaSolverUnavailableError);

    expect(submitCount.n).toBe(0);
    expect(testLogger.error).toHaveBeenCalledWith(
      expect.stringContaining("captchaGated step: solve failed")
    );
  });
});
