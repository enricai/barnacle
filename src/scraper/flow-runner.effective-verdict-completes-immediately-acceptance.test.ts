import type { Page, Stagehand } from "@browserbasehq/stagehand";
import { describe, expect, it, vi } from "vitest";
import { type HealingFlowStep, runHealingFlow } from "@/scraper/flow-runner";
import type { Logger } from "@/types/logging";

/**
 * Offline acceptance regression for the report's second explicit complaint:
 * "attempt 4 was already marked effective and the engine still proceeded to
 * attempt 5". Here the effective verdict lands on attempt 1 instead — a
 * same-page checkbox toggle (no submitStep, no submit endpoint, the flow's
 * only step so `isFinalStep` is true but `flowHasSubmitSemantics` is false,
 * matching `flow-runner.readonly-final-step-click-acceptance.test.ts`'s
 * "read-only final step" shape) whose FIRST attempt genuinely checks the box.
 *
 * **What this pins:** the completion gate (`verified`, flow-runner.ts around
 * line 11158) must credit a real DOM state change on attempt 1 immediately —
 * `stagehand.act` must be invoked exactly once for this step, and the result
 * must report the step completed on attempt 1, never burning attempts 2+ on
 * a step whose click already, genuinely, worked.
 */

const TOGGLE_STEP = "Check the 'Email me updates' checkbox";
const CHECKBOX_SELECTOR = "xpath=//input[@type='checkbox' and @name='email-updates']";

interface CapturedLogs {
  info: string[];
  warn: string[];
}

function makeCapturingLogger(): { logger: Logger; captured: CapturedLogs } {
  const captured: CapturedLogs = { info: [], warn: [] };
  const logger = {
    info: (msg: string) => {
      captured.info.push(msg);
    },
    warn: (msg: string) => {
      captured.warn.push(msg);
    },
    error: () => {},
    debug: () => {},
  } as unknown as Logger;
  return { logger, captured };
}

/** In-memory model of the same-page toggle's observable state. */
interface AcceptanceSequenceState {
  checked: boolean;
}

/** Matches `flow-runner.test.ts`'s `fakeFlowPage`: a plain top-window Page fake, no OOPIF hop. */
function makeTogglePage(state: AcceptanceSequenceState): Page {
  const session = { on: () => {}, off: () => {} };
  return {
    evaluate: async (expr: unknown) => {
      const src = String(expr);
      // snapshotPage's DOM_SNAPSHOT_EXPR probe.
      if (src.includes("outerHTML") && src.includes("innerText")) {
        return { html: 40_000, text: 500 };
      }
      // verifyDomEffect's click-branch disabled-target veto.
      if (src.includes("isDisabled")) return false;
      // verifyDomEffect's click-branch input-type probe — the resolved
      // element IS the checkbox.
      if (src.includes("el.type || null")) return "checkbox";
      // verifyDomEffect's vacuous-click ancestor-invalid guard — no
      // surrounding form is left invalid, so the checked state is genuine.
      if (src.includes("isInvalid(el)")) return false;
      return null;
    },
    url: () => "https://www.toggle-fixture.example.com/preferences",
    title: async () => "Preferences | Toggle Fixture",
    locator: () => ({
      first: () => ({
        isChecked: async () => state.checked,
      }),
    }),
    waitForTimeout: async () => {},
    getSessionForFrame: () => session,
    mainFrameId: () => "main",
    sendCDP: async () => ({ body: "{}", base64Encoded: false }),
  } as unknown as Page;
}

/**
 * Fake `Stagehand`: `act(step)` on attempt 1 genuinely checks the box — a
 * real, observable state change — and must never be called a second time.
 */
function makeToggleStagehand(state: AcceptanceSequenceState): Stagehand {
  return {
    act: vi.fn().mockImplementation(async (input: unknown) => {
      if (typeof input === "string" && input === TOGGLE_STEP) {
        state.checked = true;
        return {
          success: true,
          message: "checked",
          actionDescription: "Checked the 'Email me updates' checkbox",
          actions: [
            { selector: CHECKBOX_SELECTOR, description: "Email updates checkbox", method: "click" },
          ],
        };
      }
      return {
        success: false,
        message: "no actionable candidate",
        actionDescription: "",
        actions: [],
      };
    }),
    observe: vi.fn().mockImplementation(async (instruction?: unknown) =>
      typeof instruction === "string" && instruction === TOGGLE_STEP
        ? [
            {
              selector: CHECKBOX_SELECTOR,
              description: "Email updates checkbox",
              method: "click",
            },
          ]
        : []
    ),
  } as unknown as Stagehand;
}

const TOGGLE_STEPS: HealingFlowStep[] = [
  { instruction: TOGGLE_STEP, optional: false, upload: false, submitStep: false },
];

describe("flow-runner attempt-1-effective-verdict acceptance regression", () => {
  it("stops the cascade after attempt 1 once the toggle genuinely verifies, instead of burning further attempts", async () => {
    const state: AcceptanceSequenceState = { checked: false };
    const stagehand = makeToggleStagehand(state);
    const page = makeTogglePage(state);
    const { logger, captured } = makeCapturingLogger();

    const result = await runHealingFlow({
      stagehand,
      page,
      steps: TOGGLE_STEPS,
      logger,
      anthropic: null,
      rephraseModel: null,
      uploadFixture: null,
      submitEndpointPattern: null,
      requireSubmitEndpointMatch: false,
    });

    expect(result).toMatchObject({
      submitVerified: false,
      submitStepSkipped: false,
      lastStepIndex: 0,
    });

    // The exact defect: an already-effective verdict must not spend further
    // attempts. `act` was invoked exactly once for this step.
    expect(stagehand.act).toHaveBeenCalledTimes(1);

    // Matches the "succeeded on attempt 1" log-line shape used elsewhere in
    // the suite (flow-runner.readonly-final-step-click-acceptance.test.ts).
    expect(captured.info.some((l) => l.includes("succeeded on attempt 1"))).toBe(true);
    expect(captured.warn.some((l) => l.includes("escalating attempt 2"))).toBe(false);

    expect(state.checked).toBe(true);
  });
});
