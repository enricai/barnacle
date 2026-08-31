import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Regression for the `advanceGateActive` gate at the primary verifier
 * (flow-runner.ts): the gate used to be
 * `advanceTransitionBodyPattern !== null && isAdvanceOnlyNetwork && !isFinalStep && !submitStep`,
 * which forced `submitStep`/`isFinalStep` steps out of the
 * `waitForTransitionBody` poll entirely — `networkIsRealAdvance` fell back to
 * the raw `networkFired` boolean the instant ANY same-window POST landed
 * (e.g. an autosave that fires before the real submit transition), never
 * confirming the transition body pattern actually matched. This is a general
 * gate, not scoped to any particular site or plugin: this file proves it for
 * both a `submitStep: true` step and, separately, an `isFinalStep` step with
 * flow-level submit semantics, each verifying via the poll once the real
 * transition capture lands after the STEP_PAUSE_MS snapshot but within the
 * poll window.
 */

process.env.RECON_RUN_ID = "flow-runner-submit-step-transition-poll-test";
process.env.RECON_OUT_DIR = mkdtempSync(join(tmpdir(), "recon-submit-step-transition-poll-"));

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
  stagehand: Stagehand,
  overrides: { submitStep: boolean; isFinalStep: boolean }
): Parameters<typeof executeStepWithHealing>[0] {
  return {
    stagehand,
    page,
    step: "Click the Continue button",
    optional: false,
    upload: false,
    submitStep: overrides.submitStep,
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
    isFinalStep: overrides.isFinalStep,
    // Null so `requireSubmitEndpoint` stays false — the assertion is about
    // the primary verifier's `advanceGateActive`/poll gate, not the
    // submit-endpoint judge.
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

function makeFakePage(
  capturesDir: string,
  autosaveFile: string,
  onFirstPollInterval: () => void
): { page: Page; waitForTimeout: ReturnType<typeof vi.fn> } {
  const evaluate = vi.fn().mockImplementation(async (expr: unknown) => {
    const src = String(expr);
    if (src.includes("outerHTML")) return { html: 184186, text: "0:" };
    if (src.includes("isInvalid(el)")) return 0;
    return null;
  });
  const waitForTimeout = vi.fn().mockImplementation(async (ms: number) => {
    if (ms === ADVANCE_TRANSITION_POLL_INTERVAL_MS) onFirstPollInterval();
  });
  const page = {
    evaluate,
    url: () => "https://example.com/checkout/review",
    title: vi.fn().mockResolvedValue(""),
    locator: vi.fn().mockReturnValue({
      first: () => ({
        isChecked: vi.fn().mockResolvedValue(false),
        inputValue: vi.fn().mockResolvedValue(""),
      }),
    }),
    waitForTimeout,
  } as unknown as Page;
  writeFileSync(
    join(capturesDir, autosaveFile),
    JSON.stringify({ requestPostData: "type=autosave&field=x" })
  );
  return { page, waitForTimeout };
}

describe("flow-runner/executeStepWithHealing — advance-transition poll fires for submit/final steps", () => {
  let capturesDir: string;

  beforeAll(() => {
    capturesDir = resolveReconRunDir().graphqlDir;
  });

  // Each case's `check()` scans every file in `capturesDir` above `preIdx`
  // (which is -1 here, since `recentCaptures` is empty) — a matching
  // transition capture left behind by a prior case would let the next
  // case's initial (pre-poll) check short-circuit true, hiding whether the
  // poll itself is what does the work. Start each case from an empty dir.
  beforeEach(() => {
    rmSync(capturesDir, { recursive: true, force: true });
    mkdirSync(capturesDir, { recursive: true });
  });

  it("verifies a submitStep:true step via the poll when the real transition body lands after STEP_PAUSE_MS", async () => {
    const signalCounter = { n: 0 };
    let wroteRealCapture = false;
    const { page, waitForTimeout } = makeFakePage(capturesDir, "001-submit-autosave.json", () => {
      // Real TransitionWorklet(type=next) capture lands AFTER the
      // STEP_PAUSE_MS snapshot, during the poll — proving the poll (not the
      // initial snapshot) is what picks it up.
      if (!wroteRealCapture) {
        wroteRealCapture = true;
        writeFileSync(
          join(capturesDir, "002-submit-real.json"),
          JSON.stringify({
            requestPostData: "type=next&step=review",
            variables: { input: { type: "next" } },
          })
        );
      }
    });
    const stagehand = {
      act: vi.fn().mockImplementation(async () => {
        signalCounter.n += 1;
        return {
          success: true,
          message: "clicked",
          actionDescription: "Click the Continue button",
          actions: [
            {
              selector: "button#continue",
              description: "Click the Continue button",
              method: "click",
            },
          ],
        };
      }),
      observe: vi
        .fn()
        .mockResolvedValue([
          { selector: "button#continue", description: "continue", method: "click" },
        ]),
    } as unknown as Stagehand;

    const result = await executeStepWithHealing({
      ...baseParams(page, stagehand, { submitStep: true, isFinalStep: false }),
      signalCounter,
    });

    expect(result).toBe("completed");
    const pollWaits = waitForTimeout.mock.calls.filter(
      ([ms]) => ms === ADVANCE_TRANSITION_POLL_INTERVAL_MS
    );
    expect(pollWaits.length).toBeGreaterThan(0);
    expect(waitForTimeout.mock.calls[0]?.[0]).toBe(STEP_PAUSE_MS);
  });

  it("verifies an isFinalStep step via the poll when the real transition body lands after STEP_PAUSE_MS", async () => {
    const signalCounter = { n: 0 };
    let wroteRealCapture = false;
    const { page, waitForTimeout } = makeFakePage(capturesDir, "003-final-autosave.json", () => {
      if (!wroteRealCapture) {
        wroteRealCapture = true;
        writeFileSync(
          join(capturesDir, "004-final-real.json"),
          JSON.stringify({
            requestPostData: "type=next&step=review",
            variables: { input: { type: "next" } },
          })
        );
      }
    });
    const stagehand = {
      act: vi.fn().mockImplementation(async () => {
        signalCounter.n += 1;
        return {
          success: true,
          message: "clicked",
          actionDescription: "Click the Continue button",
          actions: [
            {
              selector: "button#continue",
              description: "Click the Continue button",
              method: "click",
            },
          ],
        };
      }),
      observe: vi
        .fn()
        .mockResolvedValue([
          { selector: "button#continue", description: "continue", method: "click" },
        ]),
    } as unknown as Stagehand;

    const result = await executeStepWithHealing({
      ...baseParams(page, stagehand, { submitStep: false, isFinalStep: true }),
      signalCounter,
    });

    expect(result).toBe("completed");
    const pollWaits = waitForTimeout.mock.calls.filter(
      ([ms]) => ms === ADVANCE_TRANSITION_POLL_INTERVAL_MS
    );
    expect(pollWaits.length).toBeGreaterThan(0);
    expect(waitForTimeout.mock.calls[0]?.[0]).toBe(STEP_PAUSE_MS);
  });
});
