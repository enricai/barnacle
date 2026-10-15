import type { Page, Stagehand } from "@browserbasehq/stagehand";
import type { Element as HappyDomElement } from "happy-dom";
import { Window } from "happy-dom";
import { describe, expect, it, vi } from "vitest";
import { answerCentreHitTest } from "@/scraper/centre-hit-test-fake.test-helper";
import {
  type AttemptRecord,
  executeStepWithHealing,
  type HealingFlowStep,
  runHealingFlow,
} from "@/scraper/flow-runner";
import type { Logger } from "@/types/logging";

/** n+16 fallback: an aria-managed checkbox the framework left unchecked vetoes retryVerified. */
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
  clickExprSources: string[];
  probeChecked?: boolean;
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
      const centred = answerCentreHitTest(expr);
      if (centred) return centred;
      const src = String(expr);
      if (src.includes("isDisabled")) {
        return false;
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
        state.clickExprSources.push(src);
        return {
          fired: true,
          kind: "checkbox",
          checked: state.probeChecked ?? false,
          ariaManaged: true,
        };
      }
      if (src.includes("outerHTML") && src.includes("innerText")) {
        return {
          html: state.bodyHtmlLength,
          text: `${state.bodyHtmlLength}:${state.visibleText}`,
        };
      }
      if (src.includes("depth < 6") && state.fallbackClickFired) {
        return true;
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
        state.url = `${BASE_URL}/name-filled`;
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
        state.url = `${BASE_URL}/documents-uploaded`;
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

describe("flow-runner n+16 aria-managed checkbox rejection (offline fixture, no network)", () => {
  it("does NOT credit an aria-checked false checkbox the framework rejected, even though other signals moved, and never writes .checked in the probe", async () => {
    const state: OnboardingSequenceState = {
      url: BASE_URL,
      bodyHtmlLength: 42_000,
      visibleText: "",
      continueClickCount: 0,
      fallbackClickFired: false,
      uploadDocsStepReached: false,
      clickExprSources: [],
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
    expect(state.url).toBe(`${BASE_URL}/name-filled`);

    // The disabled click was attempted (Stagehand reported success each
    // time, and the n+16 fallback's own synthetic click fired) but NEVER
    // credited: the flow never advanced past it into the step standing in
    // for downstream progress.
    expect(state.continueClickCount).toBeGreaterThan(0);
    expect(state.fallbackClickFired).toBe(true);
    expect(state.uploadDocsStepReached).toBe(false);
    expect(state.url).toBe(`${BASE_URL}/name-filled`);

    // The exact recon report shape on the n+16 fallback's own retry
    // snapshot: no network/url change, a nonzero body-HTML delta (the
    // fallback's own synthetic click's silent re-render) — proving the
    // disabled-target veto, not the absence of a signal, is what defeated
    // the false positive.
    expect(state.clickExprSources.length).toBeGreaterThan(0);
    const src = state.clickExprSources[0] ?? "";
    expect(src).toContain('getAttribute("aria-checked")');
    expect(src.indexOf("ariaManaged: true")).toBeLessThan(src.indexOf("el.checked = true"));
  });

  it("credits an aria-checked true checkbox without toggling it, ignoring a stale invalid ancestor", async () => {
    const state: OnboardingSequenceState = {
      url: BASE_URL,
      bodyHtmlLength: 42_000,
      visibleText: "",
      continueClickCount: 0,
      fallbackClickFired: false,
      uploadDocsStepReached: false,
      clickExprSources: [],
      probeChecked: true,
    };

    await runHealingFlow({
      stagehand: makeOnboardingStagehand(state),
      page: makeOnboardingPage(state),
      steps: ONBOARDING_STEPS,
      logger: SILENT_LOGGER,
      anthropic: null,
      rephraseModel: null,
      uploadFixture: null,
    });

    expect(state.uploadDocsStepReached).toBe(true);
    const src = state.clickExprSources[0] ?? "";
    expect(src.indexOf("ariaManaged: true")).toBeLessThan(src.indexOf("el.checked = true"));
  });
});

const AGREE_STEP = "Check the 'I agree' checkbox";
const FORM_URL = "https://apply.example.com/application/consent";

function absoluteXPathFor(el: HappyDomElement): string {
  const steps: string[] = [];
  let node: HappyDomElement | null = el;
  while (node) {
    const current: HappyDomElement = node;
    const parent: HappyDomElement | null = current.parentElement;
    if (!parent) {
      steps.unshift(`${current.tagName.toLowerCase()}[1]`);
      break;
    }
    const idx =
      Array.from(parent.children)
        .filter((c: HappyDomElement) => c.tagName === current.tagName)
        .indexOf(current) + 1;
    steps.unshift(`${current.tagName.toLowerCase()}[${idx}]`);
    node = parent;
  }
  return `/${steps.join("/")}`;
}

function resolveAbsoluteXPath(root: HappyDomElement, xp: string): HappyDomElement | null {
  let current: HappyDomElement | null = root;
  for (const step of xp.split("/").filter(Boolean).slice(1)) {
    const match = /^([a-zA-Z0-9]+)\[(\d+)\]$/.exec(step);
    if (!match || !current) return null;
    const tag = match[1]?.toUpperCase();
    const kids: HappyDomElement[] = Array.from(current.children).filter(
      (c: HappyDomElement) => c.tagName === tag
    );
    current = kids[Number(match[2]) - 1] ?? null;
  }
  return current;
}

/** Runs the real n+16 `clickExpr` against a live happy-dom checkbox whose handlers ignore synthetic events. */
async function runCheckboxFixture(html: string): Promise<{
  result: "completed" | "failed";
  checkbox: HappyDomElement;
  events: string[];
  infoLines: string[];
  attempts: AttemptRecord[][];
}> {
  const window = new Window({ url: FORM_URL });
  const document = window.document;
  document.body.innerHTML = html;
  const checkbox = document.getElementById("agree") as unknown as HappyDomElement;
  const xpath = absoluteXPathFor(checkbox);
  const events: string[] = [];
  for (const type of ["click", "change"]) {
    (
      checkbox as unknown as { addEventListener: (t: string, cb: () => void) => void }
    ).addEventListener(type, () => events.push(type));
  }
  const root = document.documentElement as unknown as HappyDomElement;
  const win = window as unknown as { XPathResult?: unknown };
  win.XPathResult = { FIRST_ORDERED_NODE_TYPE: 9 };
  (document as unknown as { evaluate: (e: string) => { singleNodeValue: unknown } }).evaluate = (
    expr: string
  ) => ({ singleNodeValue: expr.startsWith("//") ? null : resolveAbsoluteXPath(root, expr) });
  const session = { on: () => {}, off: () => {} };
  const page = {
    evaluate: async (expr: unknown): Promise<unknown> => {
      const centred = answerCentreHitTest(expr);
      if (centred) return centred;
      const fn = new window.Function("document", "XPathResult", `return (${String(expr)});`) as (
        d: unknown,
        x: unknown
      ) => unknown;
      return fn(document, win.XPathResult);
    },
    url: () => FORM_URL,
    title: async () => "Consent",
    locator: () => ({
      first: () => ({
        click: async () => {
          throw new Error("not actionable");
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
  const stagehand = {
    act: vi.fn().mockResolvedValue({
      success: true,
      message: "clicked",
      actionDescription: AGREE_STEP,
      actions: [{ selector: `xpath=${xpath}`, description: "I agree", method: "click" }],
    }),
    observe: vi
      .fn()
      .mockImplementation(async (instruction?: unknown) =>
        typeof instruction === "string"
          ? []
          : [{ selector: "xpath=//probe-presence", description: "probe-presence" }]
      ),
  } as unknown as Stagehand;
  const infoLines: string[] = [];
  const logger = {
    info: vi.fn((m: string) => infoLines.push(m)),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as unknown as Logger;
  const attempts: AttemptRecord[][] = [];
  const args = {
    stagehand,
    page,
    step: AGREE_STEP,
    optional: false,
    upload: false,
    submitStep: false,
    flowHasSubmitSemantics: false,
    stepIndex: 0,
    totalSteps: () => 2,
    phase: "flow",
    signalCounter: { n: 0 },
    recentCaptures: [],
    recentCaptureMeta: [],
    anthropic: null,
    rephraseModel: null,
    logger,
    uploadFixture: null,
    isFinalStep: false,
    submitEndpointPattern: null,
    submittedStateSelectors: [],
    requireSubmitEndpointMatch: false,
    advanceTransitionBodyPattern: null,
    successUrlFragments: [],
    successPageTitleHints: [],
    ownBackendHostnames: [],
    knownErrorClassPrefixes: [],
    wizardExitButtonLabels: [],
    onStepFailure: (a: { attempts: AttemptRecord[] }) => {
      attempts.push(a.attempts);
      return null;
    },
  } as never;
  const result = await executeStepWithHealing(args).then(
    () => "completed" as const,
    () => "failed" as const
  );
  return { result, checkbox, events, infoLines, attempts };
}

const isChecked = (el: HappyDomElement): boolean => (el as unknown as { checked: boolean }).checked;

describe("flow-runner n+16 fallback — real clickExpr on happy-dom checkboxes", () => {
  it("never forces or credits an aria-checked=false checkbox whose handler ignores synthetic events", async () => {
    const { result, checkbox, events, infoLines } = await runCheckboxFixture(
      `<div><input id="agree" type="checkbox" aria-checked="false" aria-invalid="true"></div>`
    );
    expect(result).toBe("failed");
    expect(isChecked(checkbox)).toBe(false);
    expect(events).toEqual([]);
    const probes = infoLines.filter((l) => l.includes("n+16 probe:"));
    expect(probes.length).toBeGreaterThan(0);
    for (const line of probes) expect(line).toContain("verified=false");
  });

  it("credits aria-checked=true without toggling or dispatching, despite a stale aria-invalid", async () => {
    const { result, checkbox, events, infoLines } = await runCheckboxFixture(
      `<div><input id="agree" type="checkbox" aria-checked="true" aria-invalid="true"></div>`
    );
    expect(result).toBe("completed");
    expect(isChecked(checkbox)).toBe(false);
    expect(events).toEqual([]);
    // An already-aria-checked control is credited by DOM verification on
    // attempt 1, before n+16 runs; any n+16 probe that does run must agree.
    const probes = infoLines.filter((l) => l.includes("n+16 probe:"));
    for (const line of probes) expect(line).toContain("verified=true");
  });

  it("keeps the legacy force-and-credit path for a plain native checkbox", async () => {
    const { result, checkbox, events } = await runCheckboxFixture(
      `<div><input id="agree" type="checkbox"></div>`
    );
    expect(result).toBe("completed");
    expect(isChecked(checkbox)).toBe(true);
    expect(events).toContain("click");
    expect(events).toContain("change");
  });

  it("keeps the legacy ancestor-invalid veto for a native checkbox under a stale invalid ancestor", async () => {
    const { result, checkbox, infoLines } = await runCheckboxFixture(
      `<div aria-invalid="true"><input id="agree" type="checkbox"></div>`
    );
    expect(result).toBe("failed");
    expect(isChecked(checkbox)).toBe(true);
    const probes = infoLines.filter((l) => l.includes("n+16 probe:"));
    expect(probes.length).toBeGreaterThan(0);
    for (const line of probes) expect(line).toContain("verified=false");
  });
});
