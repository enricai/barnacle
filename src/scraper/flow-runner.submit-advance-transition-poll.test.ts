import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Regression for the `advanceGateActive` exclusion at the primary verifier
 * (flow-runner.ts): `submitStep`/`isFinalStep` steps used to be forced OUT of
 * the `advanceTransitionBodyPattern` poll (`!isFinalStep && !submitStep`),
 * so `networkIsRealAdvance` fell back to the raw `networkFired` boolean —
 * true the instant ANY same-window POST landed (e.g. an autosave that fires
 * before the real submit transition), never confirming the transition body
 * pattern actually matched. Interior advance steps already got the bounded
 * `waitForTransitionBody` poll; submit/final steps did not. A submit-shaped
 * step whose network signal is present at the STEP_PAUSE_MS snapshot only
 * from a non-matching capture, with the REAL pattern-matching transition
 * capture landing during the poll window, proves the fix: the poll now runs
 * for submit steps (previously it never ran for them at all — zero
 * poll-interval `waitForTimeout` calls) and the step verifies once the real
 * transition capture is found.
 */

process.env.RECON_RUN_ID = "flow-runner-submit-advance-poll-test";
process.env.RECON_OUT_DIR = mkdtempSync(join(tmpdir(), "recon-submit-advance-poll-"));

import type { Page, Stagehand } from "@browserbasehq/stagehand";
import { executeStepWithHealing } from "@/scraper/flow-runner";
import { resolveReconRunDir } from "@/scripts/recon-shared";
import type { Logger } from "@/types/logging";

const infoMock = vi.fn();

const testLogger = {
  info: infoMock,
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

const STEP_PAUSE_MS = 2_000;
const ADVANCE_TRANSITION_POLL_INTERVAL_MS = 350;
const ADVANCE_TRANSITION_BODY_PATTERN = "type=next";

function baseParams(
  page: Page,
  stagehand: Stagehand
): Parameters<typeof executeStepWithHealing>[0] {
  return {
    stagehand,
    page,
    step: "Click the Submit button",
    optional: false,
    upload: false,
    submitStep: true,
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
    isFinalStep: false,
    // Null so `requireSubmitEndpoint` stays false — the assertion is about
    // the primary verifier's `advanceGateActive`/poll gate, not the
    // Haiku submit judge.
    submitEndpointPattern: null,
    submittedStateSelectors: [] as string[],
    requireSubmitEndpointMatch: false,
    advanceTransitionBodyPattern: ADVANCE_TRANSITION_BODY_PATTERN,
    successUrlFragments: [] as string[],
    successPageTitleHints: [] as string[],
    ownBackendHostnames: [] as string[],
    knownErrorClassPrefixes: [] as string[],
    wizardExitButtonLabels: [] as string[],
  };
}

describe("flow-runner/executeStepWithHealing — advance-transition poll fires for submit/final steps", () => {
  let capturesDir: string;

  beforeAll(() => {
    capturesDir = resolveReconRunDir().graphqlDir;
  });

  it("verifies a submit step via the poll when the real transition body lands after the STEP_PAUSE_MS snapshot", async () => {
    const signalCounter = { n: 0 };
    let wroteRealCapture = false;
    const waitForTimeout = vi.fn().mockImplementation(async (ms: number) => {
      // First poll iteration after the STEP_PAUSE_MS snapshot: this is where
      // the real TransitionWorklet(type=next) capture lands in production —
      // AFTER the snapshot, not before it. Writing it here (rather than at
      // click time) is what proves the poll — not the initial snapshot —
      // is what picks the real transition up.
      if (ms === ADVANCE_TRANSITION_POLL_INTERVAL_MS && !wroteRealCapture) {
        wroteRealCapture = true;
        writeFileSync(
          join(capturesDir, "002-apply-real.json"),
          JSON.stringify({
            requestPostData: "type=next&step=review",
            variables: { input: { type: "next" } },
          })
        );
      }
    });
    const evaluate = vi.fn().mockImplementation(async (expr: unknown) => {
      const src = String(expr);
      if (src.includes("outerHTML")) return { html: 184186, text: "0:" };
      if (src.includes("isInvalid(el)")) return 0;
      return null;
    });
    const page = {
      evaluate,
      url: () => "https://apply.example.com/jobs/1/apply-portal/apply",
      title: vi.fn().mockResolvedValue(""),
      locator: vi.fn().mockReturnValue({
        first: () => ({
          isChecked: vi.fn().mockResolvedValue(false),
          inputValue: vi.fn().mockResolvedValue(""),
        }),
      }),
      waitForTimeout,
    } as unknown as Page;
    const stagehand = {
      act: vi.fn().mockImplementation(async () => {
        // An autosave-shaped POST fires the instant the click resolves —
        // present at the STEP_PAUSE_MS snapshot but its body does NOT match
        // `advanceTransitionBodyPattern`, so it alone must not verify the
        // step (that would be the pre-fix false-credit).
        signalCounter.n += 1;
        writeFileSync(
          join(capturesDir, "001-apply-autosave.json"),
          JSON.stringify({ requestPostData: "type=autosave&field=x" })
        );
        return {
          success: true,
          message: "clicked",
          actionDescription: "Click the Submit button",
          actions: [
            { selector: "button#submit", description: "Click the Submit button", method: "click" },
          ],
        };
      }),
      observe: vi
        .fn()
        .mockResolvedValue([{ selector: "button#submit", description: "submit", method: "click" }]),
    } as unknown as Stagehand;

    const result = await executeStepWithHealing({
      ...baseParams(page, stagehand),
      signalCounter,
    });

    expect(result).toBe("completed");
    // The poll ran (interval-ms waitForTimeout calls beyond the initial
    // STEP_PAUSE_MS one) — this is the fixed behavior: previously
    // `advanceGateActive` was forced false for submitStep, so
    // `waitForTransitionBody` (and its interval waits) never ran at all.
    const pollWaits = waitForTimeout.mock.calls.filter(
      ([ms]) => ms === ADVANCE_TRANSITION_POLL_INTERVAL_MS
    );
    expect(pollWaits.length).toBeGreaterThan(0);
    // Sanity: the initial STEP_PAUSE_MS snapshot wait still happened first.
    expect(waitForTimeout.mock.calls[0]?.[0]).toBe(STEP_PAUSE_MS);
  });
});

describe("flow-runner/executeStepWithHealing — advance-gate miss log reports the poll window actually used", () => {
  let capturesDir: string;

  beforeAll(() => {
    capturesDir = resolveReconRunDir().graphqlDir;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * Regression for the advance-gate miss log at flow-runner.ts (the
   * `if (advanceGateActive && !networkIsRealAdvance)` branch): it used to
   * always interpolate `ADVANCE_TRANSITION_POLL_MS` (4000) even when the
   * preceding `waitForTransitionBody` call actually polled with the wider
   * `CAPTCHA_TRANSITION_POLL_MS` (45000) window for a `captchaGated`
   * submit/final step — misreporting a genuine 45s captcha-solve timeout as
   * an ordinary 4s miss. Drives the SAME never-matching-capture setup
   * through both a `captchaGated: true` and a `captchaGated: false` submit
   * step under fake timers (so the 45s real wait is instant) and asserts
   * the logged ms value tracks the branch actually taken.
   */
  it.each([
    { captchaGated: true, expectedMs: 45_000 },
    { captchaGated: false, expectedMs: 4_000 },
  ])(
    "logs $expectedMs ms when captchaGated=$captchaGated",
    async ({ captchaGated, expectedMs }) => {
      // Wipe captures left by sibling tests (this suite's captures dir is
      // shared across the whole file) so `windowHasAdvanceTransition`'s
      // preIdx-forward scan can't pick up an earlier test's matching
      // transition body and false-positive the poll.
      for (const filename of readdirSync(capturesDir)) {
        rmSync(join(capturesDir, filename));
      }
      vi.useFakeTimers();
      infoMock.mockClear();
      const signalCounter = { n: 0 };
      const waitForTimeout = vi
        .fn()
        .mockImplementation((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
      const evaluate = vi.fn().mockImplementation(async (expr: unknown) => {
        const src = String(expr);
        if (src.includes("outerHTML")) return { html: 184186, text: "0:" };
        if (src.includes("isInvalid(el)")) return 0;
        // No [data-sitekey] widget on the page: the captchaGated hook logs
        // and falls through to the normal cascade/advance-gate poll below,
        // which is the path this test exercises.
        if (src.includes("data-sitekey")) return { siteKey: null, isInvisible: false };
        return null;
      });
      const page = {
        evaluate,
        url: () => "https://apply.example.com/jobs/1/apply-portal/apply",
        title: vi.fn().mockResolvedValue(""),
        locator: vi.fn().mockReturnValue({
          first: () => ({
            isChecked: vi.fn().mockResolvedValue(false),
            inputValue: vi.fn().mockResolvedValue(""),
          }),
        }),
        waitForTimeout,
      } as unknown as Page;
      const stagehand = {
        act: vi.fn().mockImplementation(async () => {
          // Non-matching autosave POST only — the real transition body never
          // lands, so the poll runs out its full window and the miss branch
          // fires.
          signalCounter.n += 1;
          writeFileSync(
            join(capturesDir, `003-apply-autosave-${captchaGated}.json`),
            JSON.stringify({ requestPostData: "type=autosave&field=x" })
          );
          return {
            success: true,
            message: "clicked",
            actionDescription: "Click the Submit button",
            actions: [
              {
                selector: "button#submit",
                description: "Click the Submit button",
                method: "click",
              },
            ],
          };
        }),
        observe: vi
          .fn()
          .mockResolvedValue([
            { selector: "button#submit", description: "submit", method: "click" },
          ]),
      } as unknown as Stagehand;

      const resultPromise = executeStepWithHealing({
        ...baseParams(page, stagehand),
        captchaGated,
        signalCounter,
      }).catch(() => undefined);
      await vi.runAllTimersAsync();
      await resultPromise;

      const missLog = infoMock.mock.calls
        .map((call: unknown[]) => String(call[0]))
        .find((msg: string) => msg.includes("no advance-transition (type=next) body matched"));
      expect(missLog).toContain(`within ${expectedMs}ms poll`);
    }
  );
});
