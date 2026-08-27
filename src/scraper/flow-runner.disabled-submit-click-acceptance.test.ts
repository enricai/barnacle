import type { Page, Stagehand } from "@browserbasehq/stagehand";
import { describe, expect, it, vi } from "vitest";
import { type HealingFlowStep, runHealingFlow } from "@/scraper/flow-runner";
import type { Logger } from "@/types/logging";

/**
 * Offline acceptance regression for the n+16 `el.click()` fallback probe
 * path specifically: a disabled submit control resolved via an `xpath=`
 * selector (the only selector shape that reaches the n+16 fallback —
 * `xpathBody` returns null for a `css=` selector) whose click Stagehand
 * REPORTS successful but that produces exactly the recon report's weak
 * signal shape on the fallback's own retry snapshot: no network, no URL
 * change, a nonzero body-HTML delta (a silent aria-live re-render the
 * fallback's own synthetic click triggers), no visible-text change, no
 * form-value change. `flow-runner.viewswap-blocked-submit-acceptance.test.ts`
 * pins the sibling `css=`-selector path through `verifyDomEffect`'s /
 * `isClickViewSwapVerified`'s primary-verifier veto; this fixture is
 * modeled on it but exercises the OTHER veto site — `clickBlockedByDisabled`
 * inside the n+16 fallback block in `flow-runner.ts` — so the weak
 * htmlDelta-only signal there can't ride a disabled target to a false
 * credit either.
 *
 * Uses a generic multi-field onboarding form (unrelated to any named
 * site/plugin): a "Phone Number" field is never filled, so the "Continue"
 * submit control stays disabled/`aria-disabled`, and the click must never
 * be scored verified — the flow must reject with `StepVerificationError`
 * rather than reach the step standing in for what would otherwise be
 * downstream progress.
 */

const BASE_URL = "https://example-onboarding.example.com/apply/profile";

const NAME_STEP = "Fill in the 'Full Name' field with 'Jordan Alvarez'";
/** Verbatim shape of the report's blocked click: 'Phone Number' is left empty, so 'Continue' stays disabled. */
const CONTINUE_STEP = "Click the 'Continue' button";
/** Stands in for downstream progress — must never run if the disabled 'Continue' click is (correctly) never credited. */
const UPLOAD_DOCS_STEP = "Click the 'Upload Documents' button";

const SILENT_LOGGER = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as unknown as Logger;

/** In-memory model of the onboarding page's observable state. */
interface OnboardingSequenceState {
  url: string;
  /** `document.body.outerHTML.length` — grows only once, on the n+16 fallback's own synthetic click. */
  bodyHtmlLength: number;
  /** Visible text beyond the base copy — never changes: the growth is a silent aria-live re-render, not visible copy. */
  visibleText: string;
  continueClickCount: number;
  /** Whether the n+16 fallback's own synthetic `el.click()` has fired once yet. */
  fallbackClickFired: boolean;
  uploadDocsStepReached: boolean;
}

/**
 * Matches `flow-runner.test.ts`'s `fakeFlowPage` DOM-evaluate surface, plus
 * the two additional expression shapes the n+16 fallback probes: the
 * `DISABLED_MARKER_EL_EXPR`-based disabled check (shared by the primary
 * verifier's `verifyDomEffect` click branch and the n+16 fallback's own
 * `clickBlockedByDisabled` veto — both compiled expressions contain
 * `isDisabled`) and the fallback's native `el.click()` firing expression
 * (contains `typeof el.click`, unique to that expression among all the
 * others this fixture needs to answer).
 */
function makeOnboardingPage(state: OnboardingSequenceState): Page {
  const session = { on: () => {}, off: () => {} };
  return {
    evaluate: async (expr: unknown) => {
      const src = String(expr);
      if (src.includes("isDisabled")) {
        // 'Continue' stays disabled for the whole run: the required 'Phone
        // Number' field was never committed, exactly the report's condition.
        return true;
      }
      if (src.includes("typeof el.click")) {
        // The n+16 fallback's own synthetic click: on its FIRST firing only,
        // trigger a silent aria-live re-render (html grows, visible text and
        // form values do not) — the exact weak-signal shape a buggy fallback
        // would otherwise credit as verified.
        if (!state.fallbackClickFired) {
          state.fallbackClickFired = true;
          state.bodyHtmlLength += 240;
        }
        return { fired: true, kind: "click" };
      }
      if (src.includes("outerHTML") && src.includes("innerText")) {
        return {
          html: state.bodyHtmlLength,
          text: `${state.bodyHtmlLength}:${state.visibleText}`,
        };
      }
      if (src.includes("isInvalid(el)")) return 0;
      return null;
    },
    url: () => state.url,
    title: async () => "Profile | Onboarding",
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

/** Best-effort flattening of an `act()` input into a string the fixture can pattern-match against. */
function describeActInput(input: unknown): string {
  if (typeof input === "string") return input;
  try {
    return JSON.stringify(input);
  } catch {
    return "";
  }
}

/**
 * Fake `Stagehand`: `act()` resolves the field-fill step as a verified
 * URL-changing action, and resolves "Continue" as a click that Stagehand
 * REPORTS successful via an `xpath=` selector (the shape that reaches the
 * n+16 fallback) but that produces zero observable effect on its own — the
 * CDP click lands on the disabled control without firing anything, matching
 * the n+16 fallback's own doc comment ("Stagehand's CDP click sometimes
 * lands on the button without triggering React's SyntheticEvent layer").
 * `observe()` stays blind throughout, so the resolved click's own
 * verification signals (primary + n+16 fallback) are the only thing
 * standing between a false credit and a correctly-failed step.
 */
function makeOnboardingStagehand(state: OnboardingSequenceState): Stagehand {
  return {
    act: vi.fn().mockImplementation(async (input: unknown) => {
      const description = describeActInput(input);
      if (description.includes("Full Name")) {
        state.url = `${BASE_URL}#name-filled`;
        return {
          success: true,
          message: "filled",
          actionDescription: NAME_STEP,
          actions: [
            {
              selector: "css=[data-automation-id=fullName]",
              description: "Full Name",
              method: "fill",
              arguments: ["Jordan Alvarez"],
            },
          ],
        };
      }
      if (description.includes("Continue")) {
        state.continueClickCount += 1;
        // No URL change, no network call, no DOM growth from the reported
        // act() attempt itself — the growth (if any) only comes from the
        // n+16 fallback's OWN synthetic click, exercised below.
        return {
          success: true,
          message: "clicked",
          actionDescription: CONTINUE_STEP,
          actions: [
            {
              selector: "xpath=//button[@data-automation-id='continue']",
              description: "Continue",
              method: "click",
            },
          ],
        };
      }
      if (description.includes("Upload Documents")) {
        state.uploadDocsStepReached = true;
        state.url = `${BASE_URL}#documents-uploaded`;
        return {
          success: true,
          message: "clicked",
          actionDescription: UPLOAD_DOCS_STEP,
          actions: [
            {
              selector: "css=[data-automation-id=uploadDocuments]",
              description: "Upload Documents",
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
    // Focused (instruction-scoped) observe stays blind — every step verifies
    // via act()'s own reported action, never an observe candidate. Unfocused
    // observe returns a stub "page has content" candidate so
    // `probeStepBeforeAttempts`'s reachability fallback hands off to the
    // cascade instead of short-circuiting to "absent" before act() ever runs.
    observe: vi
      .fn()
      .mockImplementation(async (instruction?: unknown) =>
        typeof instruction === "string"
          ? []
          : [{ selector: "xpath=//probe-presence", description: "probe-presence" }]
      ),
  } as unknown as Stagehand;
}

const ONBOARDING_STEPS: HealingFlowStep[] = [
  { instruction: NAME_STEP, optional: false, upload: false, submitStep: false },
  { instruction: CONTINUE_STEP, optional: false, upload: false, submitStep: false },
  { instruction: UPLOAD_DOCS_STEP, optional: false, upload: false, submitStep: false },
];

describe("flow-runner disabled-submit n+16 fallback acceptance regression (disabled-click-target-veto, offline fixture, no network)", () => {
  it("does NOT credit a disabled 'Continue' click via the n+16 el.click() fallback's weak DOM-only signal, even though the fallback's own click grows the body HTML with no text/form-value/network/url change", async () => {
    const state: OnboardingSequenceState = {
      url: BASE_URL,
      bodyHtmlLength: 42_000,
      visibleText: "",
      continueClickCount: 0,
      fallbackClickFired: false,
      uploadDocsStepReached: false,
    };

    const stagehand = makeOnboardingStagehand(state);
    const page = makeOnboardingPage(state);

    await expect(
      runHealingFlow({
        stagehand,
        page,
        steps: ONBOARDING_STEPS,
        logger: SILENT_LOGGER,
        anthropic: null,
        rephraseModel: null,
        uploadFixture: null,
      })
    ).rejects.toMatchObject({
      name: "StepVerificationError",
    });

    // The 'Full Name' fill step (verified via a real URL change) ran before
    // the disabled click, proving the failure is attributable to 'Continue'
    // specifically, not an earlier setup failure.
    expect(state.url).toBe(`${BASE_URL}#name-filled`);

    // The disabled click was attempted (Stagehand reported success each
    // time, and the n+16 fallback's own synthetic click fired) but NEVER
    // credited: the flow never advanced past it into the step standing in
    // for downstream progress.
    expect(state.continueClickCount).toBeGreaterThan(0);
    expect(state.fallbackClickFired).toBe(true);
    expect(state.uploadDocsStepReached).toBe(false);
    expect(state.url).toBe(`${BASE_URL}#name-filled`);

    // The exact recon report shape on the n+16 fallback's own retry
    // snapshot: no network/url change, a nonzero body-HTML delta (the
    // fallback's own synthetic click's silent re-render) — proving the
    // disabled-target veto, not the absence of a signal, is what defeated
    // the false positive.
    expect(state.bodyHtmlLength).toBe(42_240);
    expect(state.visibleText).toBe("");
  });
});
