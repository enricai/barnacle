import type { Page, Stagehand } from "@browserbasehq/stagehand";
import { describe, expect, it, vi } from "vitest";
import { type HealingFlowStep, runHealingFlow } from "@/scraper/flow-runner";
import type { Logger } from "@/types/logging";

/**
 * Offline acceptance regression for
 * `docs/recon-viewswap-false-positive-on-blocked-form-submit.md`: the exact
 * CVS Health (Phenom→Workday) "Create Account" repro. `verifyPassword` and
 * the "I Agree" checkbox are left empty; the "Create Account" click is
 * blocked by Workday's inline required-field validation (network=false,
 * url=false, the step-progress indicator stays "step 1 of 8" before and
 * after). Prior to bugfix-001 (`isClickViewSwapVerified`'s
 * `invalidMarkerDelta` veto), the inline-error DOM growth alone rode the
 * view-swap reveal-credit branch to `verifiedBy=view-swap`, silently
 * advancing recon past a step the wizard never left and skipping every
 * downstream step (the report's steps 9-12) as if step 8 had succeeded.
 *
 * **What this pins:** `executeStepWithHealing`'s click-attempt call site
 * (flow-runner.ts, the `postInvalidMarkerCount`/`preInvalidMarkerCount`
 * wiring around `isClickViewSwapVerified`) vetoes the credit when the
 * post-click ng-invalid marker count grows, so the blocked "Create Account"
 * click never verifies, the cascade exhausts, `runHealingFlow` rejects with
 * `StepVerificationError`, and the flow step standing in for the report's
 * steps 9-12 is never reached.
 *
 * **Structure:** Modeled on `flow-runner.test.ts`'s `flow-runner/
 * runHealingFlow` describe block's `fakeFlowPage` (plain top-window Page
 * fake — no deep-locator/OOPIF hop needed since Workday's Create Account
 * form is not embedded) and
 * `flow-runner.replan-preserve-remaining-steps.test.ts`'s
 * `AcceptanceSequenceState` pattern (a single mutable state object threaded
 * through the fake `Stagehand`/`Page`, asserted against after the run).
 */

const BASE_URL = "https://cvshealth.wd1.myworkdayjobs.com/CVS_Health_Careers/createAccount";
const STEP_INDICATOR_TEXT = "current step 1 of 8";

const EMAIL_STEP = "Fill in the 'Email Address' field with 'jane.doe@example.com'";
const PASSWORD_STEP = "Fill in the 'Password' field with 'Secr3t!Passw0rd'";
/** Verbatim shape of the report's blocked click: verifyPassword and "I Agree" are left empty, so the click is rejected by inline validation. */
const CREATE_ACCOUNT_STEP = "Click the 'Create Account' button";
/** Stands in for the report's steps 9-12 — must never run if step 8's blocked submit is (correctly) never credited. */
const UPLOAD_RESUME_STEP = "Click the 'Select Files' button to upload your resume";

const SILENT_LOGGER = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as unknown as Logger;

/** In-memory model of the Workday Create Account page's observable state. */
interface WorkdaySequenceState {
  url: string;
  /** `document.body.outerHTML.length` — grows only once, when the blocked submit first renders its inline errors. */
  bodyHtmlLength: number;
  /** Visible text beyond the step indicator — accumulates the inline validation error text on the first blocked submit. */
  visibleText: string;
  /** ng-invalid-style container count (`countNgInvalidContainers`) — 0 until the first blocked submit reveals the two empty required fields. */
  invalidMarkerCount: number;
  /** The step-progress indicator text (`"current step N of 8"`) — the report's literal evidence that the wizard never advanced. */
  stepIndicatorText: string;
  createAccountClickCount: number;
  uploadResumeStepReached: boolean;
}

/** Matches `flow-runner.test.ts`'s `fakeFlowPage`: the plain DOM-evaluate surface `executeStepWithHealing` touches for a click/fill step with no select/checkbox/radio primitives in play. */
function makeWorkdayPage(state: WorkdaySequenceState): Page {
  const session = { on: () => {}, off: () => {} };
  return {
    evaluate: async (expr: unknown) => {
      const src = String(expr);
      if (src.includes("outerHTML") && src.includes("innerText")) {
        return {
          html: state.bodyHtmlLength,
          text: `${state.bodyHtmlLength}:${state.stepIndicatorText} ${state.visibleText}`,
        };
      }
      if (src.includes("isInvalid(el)")) return state.invalidMarkerCount;
      return null;
    },
    url: () => state.url,
    title: async () => "Create Account | Workday",
    locator: () => ({
      first: () => ({
        isChecked: async () => false,
        inputValue: async () => "",
      }),
    }),
    waitForTimeout: async () => {},
    getSessionForFrame: () => session,
    mainFrameId: () => "main",
    sendCDP: async () => ({ body: "{}", base64Encoded: false }),
  } as unknown as Page;
}

/** Best-effort flattening of an `act()` input (a plain instruction string on attempt 1, a candidate action object on the observe-act fallback) into a string the fixture can pattern-match against. */
function describeActInput(input: unknown): string {
  if (typeof input === "string") return input;
  try {
    return JSON.stringify(input);
  } catch {
    return "";
  }
}

/**
 * Fake `Stagehand`: `act()` resolves each of the flow's field-fill steps as
 * a verified URL-changing action, and resolves "Create Account" as a click
 * that is REPORTED successful by Stagehand but — matching the report's
 * `network=false url=false dom=false` repro exactly — never changes the
 * URL, never fires network, and (only on its first invocation, matching a
 * real blocked resubmit re-rendering the SAME errors rather than
 * accumulating new ones) grows the DOM with inline validation errors and
 * marks the two empty required fields invalid. `observe()` stays blind
 * (`[]`) throughout, matching the field condition this whole acceptance
 * suite family models: no rephrase/observe candidate ever rescues the
 * cascade, so the blocked click's own verification signals are the only
 * thing standing between a false credit and a correctly-failed step.
 */
function makeWorkdayStagehand(state: WorkdaySequenceState): Stagehand {
  return {
    act: vi.fn().mockImplementation(async (input: unknown) => {
      const description = describeActInput(input);
      if (description.includes("Email Address")) {
        state.url = `${BASE_URL}#email-filled`;
        return {
          success: true,
          message: "filled",
          actionDescription: EMAIL_STEP,
          actions: [
            {
              selector: "css=[data-automation-id=email]",
              description: "Email Address",
              method: "fill",
              arguments: ["jane.doe@example.com"],
            },
          ],
        };
      }
      if (description.includes("'Password'")) {
        state.url = `${BASE_URL}#password-filled`;
        return {
          success: true,
          message: "filled",
          actionDescription: PASSWORD_STEP,
          actions: [
            {
              selector: "css=[data-automation-id=password]",
              description: "Password",
              method: "fill",
              arguments: ["Secr3t!Passw0rd"],
            },
          ],
        };
      }
      if (description.includes("Create Account")) {
        state.createAccountClickCount += 1;
        // Blocked submit: Workday rejects the click (verifyPassword and "I
        // Agree" are empty) and re-renders the SAME inline errors — the DOM
        // growth and invalid-marker count only move on the FIRST blocked
        // attempt, exactly like a real resubmit against an unchanged form.
        if (state.invalidMarkerCount === 0) {
          state.invalidMarkerCount = 2;
          state.bodyHtmlLength += 1800;
          state.visibleText =
            "Please enter a value in this field. Please check this box if you want to proceed.";
        }
        // No URL change, no network call — the exact false-positive shape.
        return {
          success: true,
          message: "clicked",
          actionDescription: CREATE_ACCOUNT_STEP,
          actions: [
            {
              selector: "css=[data-automation-id=createAccountSubmitButton]",
              description: "Create Account",
              method: "click",
            },
          ],
        };
      }
      if (description.includes("Select Files")) {
        state.uploadResumeStepReached = true;
        state.url = `${BASE_URL}#resume-uploaded`;
        return {
          success: true,
          message: "clicked",
          actionDescription: UPLOAD_RESUME_STEP,
          actions: [
            {
              selector: "css=[data-automation-id=select-files]",
              description: "Select Files",
              method: "click",
            },
          ],
        };
      }
      return {
        success: false,
        message: "no actionable candidate",
        actionDescription: description,
        actions: [],
      };
    }),
    // Focused (instruction-scoped) observe stays blind — every step
    // verifies via `act()`'s own reported action, never an observe
    // candidate. Unfocused observe (instruction omitted) returns a stub
    // "page has content" candidate so `probeStepBeforeAttempts`'s
    // reachability fallback treats every step as present and hands off to
    // the cascade, instead of short-circuiting to "absent" before `act()`
    // ever runs.
    observe: vi
      .fn()
      .mockImplementation(async (instruction?: unknown) =>
        typeof instruction === "string"
          ? []
          : [{ selector: "xpath=//probe-presence", description: "probe-presence" }]
      ),
  } as unknown as Stagehand;
}

const WORKDAY_STEPS: HealingFlowStep[] = [
  { instruction: EMAIL_STEP, optional: false, upload: false, submitStep: false },
  { instruction: PASSWORD_STEP, optional: false, upload: false, submitStep: false },
  { instruction: CREATE_ACCOUNT_STEP, optional: false, upload: false, submitStep: false },
  { instruction: UPLOAD_RESUME_STEP, optional: false, upload: false, submitStep: false },
];

describe("flow-runner CVS Workday blocked Create-Account acceptance regression (bugfix-001, offline fixture, no network)", () => {
  it("does NOT credit the blocked 'Create Account' click via view-swap, exhausts the cascade instead of skipping ahead, and never reaches the downstream steps standing in for the report's steps 9-12", async () => {
    const state: WorkdaySequenceState = {
      url: BASE_URL,
      bodyHtmlLength: 42_000,
      visibleText: "",
      invalidMarkerCount: 0,
      stepIndicatorText: STEP_INDICATOR_TEXT,
      createAccountClickCount: 0,
      uploadResumeStepReached: false,
    };

    const stagehand = makeWorkdayStagehand(state);
    const page = makeWorkdayPage(state);

    await expect(
      runHealingFlow({
        stagehand,
        page,
        steps: WORKDAY_STEPS,
        logger: SILENT_LOGGER,
        anthropic: null,
        rephraseModel: null,
        uploadFixture: null,
      })
    ).rejects.toMatchObject({
      name: "StepVerificationError",
    });

    // The email/password fill steps (each verified via a real URL change)
    // ran before the blocked click, proving the failure is attributable to
    // the "Create Account" step specifically, not an earlier setup failure.
    expect(state.url).not.toBe(BASE_URL);

    // The blocked click was attempted (Stagehand reported success each
    // time) but NEVER credited: the flow never advanced past it into the
    // step standing in for the report's steps 9-12.
    expect(state.createAccountClickCount).toBeGreaterThan(0);
    expect(state.uploadResumeStepReached).toBe(false);

    // The wizard genuinely never left the Create Account view: no network,
    // no URL change, and the step-progress indicator is byte-identical
    // before and after every blocked attempt — the report's literal "step 1
    // of 8 unchanged" evidence.
    expect(state.url).toBe(`${BASE_URL}#password-filled`);
    expect(state.stepIndicatorText).toBe(STEP_INDICATOR_TEXT);

    // The blocked submit did reveal inline validation errors (the exact
    // DOM-growth + text-change shape the view-swap reveal-credit branch
    // would otherwise reward) — proving the veto, not the absence of a
    // signal, is what defeated the false positive.
    expect(state.invalidMarkerCount).toBe(2);
    expect(state.bodyHtmlLength).toBeGreaterThan(42_000);
  });
});
