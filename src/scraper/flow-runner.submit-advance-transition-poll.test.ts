import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeAll, describe, expect, it, vi } from "vitest";

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

const testLogger = {
  info: vi.fn(),
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
