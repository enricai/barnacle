import type { Page, Stagehand } from "@browserbasehq/stagehand";
import { describe, expect, it, vi } from "vitest";
import { type HealingFlowStep, runHealingFlow } from "@/scraper/flow-runner";
import type { Logger } from "@/types/logging";

/**
 * Offline acceptance regression for
 * `docs/recon-readonly-final-step-misclassified-as-submit.md`: a read-only
 * flow (no `submitStep` anywhere, no `submitEndpointPattern`,
 * `requireSubmitEndpointMatch: false`) whose FINAL step is an ordinary
 * data-viewing click — the report's "click a stateroom category tab" case.
 * Attempt 1 phantom-clicks (Stagehand reports success but pre/post shows
 * zero network/url/dom change), which is exactly the report's step-10 log.
 *
 * **What this pins:** `isFinalStep` alone must no longer make the step
 * "submit-shaped". Before the fix, `submitShapedStep` was derived as
 * `isFinalStep || submitStep`, which routed the escalation to
 * `deep-submit-locator` (finding no submit-shaped candidate) and then
 * SKIPPED `structured-click` / `observe-act-exclude` with a "submit-shaped
 * step" reason — even though the flow declares no submit semantics at all.
 * `flowHasSubmitSemantics` now gates that: `submitShapedStep = submitStep ||
 * (isFinalStep && flowHasSubmitSemantics)`, so a read-only flow's final step
 * falls through to the ordinary non-submit phantom branch
 * (`trusted-click-retry`) and keeps the full light-DOM click ladder
 * (`structured-click`, `observe-act-exclude`) available.
 *
 * **Structure:** Modeled on
 * `flow-runner.viewswap-blocked-submit-acceptance.test.ts`'s single mutable
 * `AcceptanceSequenceState` threaded through fake `Stagehand`/`Page`
 * objects, asserted against captured logger lines after `runHealingFlow`
 * resolves.
 */

const BASE_URL = "https://www.royalcaribbean.com/cruises";
const TAB_STEP =
  "Click the 'Balcony' stateroom category tab to view that category's per-cabin price";

/** The report's literal "probe found 4 candidate(s)" — the four stateroom tabs. */
const TAB_CANDIDATES = [
  {
    selector: "xpath=//button[@data-tab='interior']",
    description: "Interior tab",
    method: "click",
  },
  {
    selector: "xpath=//button[@data-tab='oceanview']",
    description: "Oceanview tab",
    method: "click",
  },
  { selector: "xpath=//button[@data-tab='balcony']", description: "Balcony tab", method: "click" },
  { selector: "xpath=//button[@data-tab='suite']", description: "Suite tab", method: "click" },
];
// biome-ignore lint/style/noNonNullAssertion: fixed-length literal array above
const BALCONY_CANDIDATE = TAB_CANDIDATES[2]!;

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

/** In-memory model of the read-only tab-detail page's observable state. */
interface AcceptanceSequenceState {
  url: string;
  bodyHtmlLength: number;
  visibleText: string;
  networkCount: number;
  balconyTabClicked: boolean;
}

/** Matches `flow-runner.test.ts`'s `fakeFlowPage`: a plain top-window Page fake, no OOPIF hop. */
function makeReadonlyFlowPage(state: AcceptanceSequenceState): Page {
  const session = { on: () => {}, off: () => {} };
  return {
    evaluate: async (expr: unknown) => {
      const src = String(expr);
      if (src.includes("outerHTML") && src.includes("innerText")) {
        return { html: state.bodyHtmlLength, text: state.visibleText };
      }
      if (src.includes("isInvalid(el)")) return 0;
      // structured-click's checkable-input probe: the resolved xpath IS a
      // <button> tab, not a radio/checkbox, so no checkable input is
      // reachable — the report's target is a tab, not a form control.
      if (src.includes("isCheckable")) return { resolved: true, isCheckable: false };
      return null;
    },
    url: () => state.url,
    title: async () => "Cruises | Royal Caribbean",
    locator: () => ({
      first: () => ({
        // trusted-click-retry's top-window arm: the trusted CDP-style click
        // throws (the target isn't reachable via a plain Playwright locator
        // in this offline fixture), forcing the cascade past attempt 2 —
        // proof that attempt 3/4 genuinely run rather than being skipped.
        click: async () => {
          throw new Error("locator resolved to 0 elements");
        },
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

/**
 * Fake `Stagehand`: `observe(step, ...)` always reports the four stateroom
 * tabs (the report's "probe found 4 candidate(s)"). `act(step)` on attempt 1
 * (act-string) reports success on the balcony tab but leaves url/network/dom
 * completely unchanged — the report's literal phantom-click repro. Attempt 4
 * (observe-act-exclude) resolves one of the 4 tabs via an observe candidate
 * object (not the instruction string) and this time the click has a REAL
 * effect (URL changes to the per-cabin pricing view), so the step verifies
 * via the light-DOM click ladder — never via `deep-submit-locator`.
 */
function makeReadonlyFlowStagehand(state: AcceptanceSequenceState): Stagehand {
  return {
    act: vi.fn().mockImplementation(async (input: unknown) => {
      if (typeof input === "string" && input === TAB_STEP) {
        // Attempt 1 (act-string): reported success, but a genuine phantom —
        // no network/url/dom change at all.
        return {
          success: true,
          message: "clicked",
          actionDescription: `Clicked "${BALCONY_CANDIDATE.description}"`,
          actions: [BALCONY_CANDIDATE],
        };
      }
      // Attempt 4 (observe-act-exclude) hands back an observe candidate
      // object, not the instruction string — this is the click that
      // actually lands and produces an observable effect. Any of the 4
      // stateroom tabs (attempt 4's `ignoreSelectors` demotes the balcony
      // candidate the phantomed attempt 1 already tried) genuinely clicking
      // through is what proves the light-DOM ladder reached the target — the
      // report's exact "4 candidate(s)" shape.
      const target = input as { selector?: string; description?: string };
      const matched = TAB_CANDIDATES.find((c) => c.selector === target?.selector);
      if (matched) {
        state.balconyTabClicked = true;
        state.url = `${BASE_URL}#category=${matched.selector.match(/data-tab='(\w+)'/)?.[1]}`;
        state.networkCount += 1;
        state.bodyHtmlLength += 6_000;
        state.visibleText = "Stateroom prices from $1,299 per person";
        return {
          success: true,
          message: "clicked",
          actionDescription: `Clicked "${target.description}"`,
          actions: [{ ...matched, method: "click" }],
        };
      }
      return {
        success: false,
        message: "no actionable candidate",
        actionDescription: "",
        actions: [],
      };
    }),
    observe: vi
      .fn()
      .mockImplementation(async (instruction?: unknown) =>
        typeof instruction === "string" && instruction === TAB_STEP ? TAB_CANDIDATES : []
      ),
  } as unknown as Stagehand;
}

const READONLY_STEPS: HealingFlowStep[] = [
  { instruction: TAB_STEP, optional: false, upload: false, submitStep: false },
];

describe("flow-runner read-only final-step phantom-click acceptance regression (docs/recon-readonly-final-step-misclassified-as-submit.md)", () => {
  it("falls through to the light-DOM click ladder instead of routing a read-only flow's final step to deep-submit-locator", async () => {
    const state: AcceptanceSequenceState = {
      url: BASE_URL,
      bodyHtmlLength: 42_000,
      visibleText: "current step 10 of 10",
      networkCount: 0,
      balconyTabClicked: false,
    };
    const stagehand = makeReadonlyFlowStagehand(state);
    const page = makeReadonlyFlowPage(state);
    const { logger, captured } = makeCapturingLogger();

    const result = await runHealingFlow({
      stagehand,
      page,
      steps: READONLY_STEPS,
      logger,
      anthropic: null,
      rephraseModel: null,
      uploadFixture: null,
      // Explicit read-only declaration, matching the report's flow exactly:
      // no submitStep on any step (READONLY_STEPS), no submitEndpointPattern,
      // requireSubmitEndpointMatch: false.
      submitEndpointPattern: null,
      requireSubmitEndpointMatch: false,
    });

    expect(result).toMatchObject({
      submitVerified: false,
      submitStepSkipped: false,
      lastStepIndex: 0,
    });

    // The probe found the report's 4 candidates before any attempt ran.
    expect(captured.info.some((l) => l.includes("probe found 4 candidate(s)"))).toBe(true);

    // Attempt 1 phantom-clicked, and the cascade escalated to the NON-submit
    // branch (trusted-click-retry), never deep-submit-locator — the whole
    // point of flowHasSubmitSemantics gating isFinalStep.
    expect(
      captured.warn.some((l) =>
        l.includes(
          "non-submit step — escalating attempt 2 to trusted-click-retry (trusted CDP click on the resolved target)"
        )
      )
    ).toBe(true);
    expect(
      captured.warn.some((l) => l.includes("escalating attempt 2 to deep-submit-locator"))
    ).toBe(false);

    // deep-submit-locator never ran at all: no candidate ranking, no
    // "no submit-shaped candidate found" line.
    expect(captured.info.some((l) => l.includes("deep-submit-locator"))).toBe(false);
    expect(captured.warn.some((l) => l.includes("deep-submit-locator"))).toBe(false);

    // structured-click (attempt 3) and observe-act-exclude (attempt 4) were
    // NOT skipped for being on a "submit-shaped step" — the exact skip the
    // report identifies as the defect.
    const submitShapedSkips = [...captured.info, ...captured.warn].filter(
      (l) => l.includes("skipped") && l.includes("submit-shaped step")
    );
    expect(submitShapedSkips).toEqual([]);

    // The light-DOM click ladder reached and clicked one of the 4 tabs —
    // the exact target the report says the probe found but the old gating
    // never let the cascade reach.
    expect(state.balconyTabClicked).toBe(true);
    expect(state.url).not.toBe(BASE_URL);
  });
});
