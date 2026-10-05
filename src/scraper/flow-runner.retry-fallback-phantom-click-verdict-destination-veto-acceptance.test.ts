import type { Page, Stagehand } from "@browserbasehq/stagehand";
import type { Element as HappyDomElement } from "happy-dom";
import { Window } from "happy-dom";
import { describe, expect, it, vi } from "vitest";
import { type AttemptRecord, executeStepWithHealing } from "@/scraper/flow-runner";
import type { Logger } from "@/types/logging";

/**
 * Acceptance coverage for the n+16 synthetic `el.click()` fallback's
 * `retryVerdict` disjunct (flow-runner.ts's `retryVerified` computation,
 * `(!retrySubmitShaped && retryVerdict === "effective")`, ~12805): proves
 * the WIRING from this call site into `classifyPhantomClick` — that
 * `destinationPlausible` (computed via `isPlausibleStepDestination` two
 * lines above and passed into `classifyPhantomClick`) actually reaches and
 * gates its `bytesChangedSignificantly` branch, so a page-wide HTML-byte
 * delta alone can't credit a click that bounced to a sign-in-shaped
 * destination for a step that was never about signing in.
 * Distinct from
 * flow-runner.retry-fallback-weakdomsignals-destination-plausibility-veto-
 * acceptance.test.ts, which isolates the SEPARATE `weakDomSignalsAllowed`
 * disjunct: this test uses a checkbox/radio-intent step instruction so
 * `isCheckboxOrRadioIntentStep(step)` is true, making `weakDomSignalsAllowed`
 * structurally false regardless of that disjunct's own fix, keeping only the
 * `retryVerdict === "effective"` disjunct (fed by `classifyPhantomClick`'s
 * `bytesChangedSignificantly` branch) live. The clicked element is a plain
 * `<a>` (not an actual checkbox input), so the fallback's own
 * `checkboxStateVerified` branch never engages either — the step's
 * checkbox/radio PHRASING drives `isCheckboxOrRadioIntentStep`, not the
 * resolved DOM element's type. Step stays non-submit-shaped throughout
 * (`retrySubmitShaped` false) so classifyPhantomClick's plausibility-aware
 * OR-branch is reachable, matching the destination-plausibility pattern
 * flow-runner.retry-fallback-destination-plausibility-veto-acceptance.test.ts
 * already established for the `retryUrlChanged` disjunct.
 * Site-agnostic fixture (generic "shop.example.com" preferences flow), not
 * any real site or plugin.
 */

const BASE_URL = "https://shop.example.com/account/preferences";
const CHECKBOX_STEP = "Check the 'Subscribe to updates' checkbox";

const INFO_LINES: string[] = [];
const testLogger = {
  info: vi.fn((m: string) => INFO_LINES.push(m)),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

function absoluteXPathFor(el: HappyDomElement): string {
  const steps: string[] = [];
  let node: HappyDomElement | null = el;
  while (node) {
    const currentNode: HappyDomElement = node;
    const parent: HappyDomElement | null = currentNode.parentElement;
    if (!parent) {
      steps.unshift(`${currentNode.tagName.toLowerCase()}[1]`);
      break;
    }
    const sameTag = Array.from(parent.children).filter(
      (c: HappyDomElement) => c.tagName === currentNode.tagName
    );
    const idx = sameTag.indexOf(currentNode) + 1;
    steps.unshift(`${node.tagName.toLowerCase()}[${idx}]`);
    node = parent;
  }
  return `/${steps.join("/")}`;
}

function resolveAbsoluteXPath(root: HappyDomElement, xp: string): HappyDomElement | null {
  const steps = xp
    .split("/")
    .filter(Boolean)
    .map((step) => {
      const match = /^([a-zA-Z0-9]+)\[(\d+)\]$/.exec(step);
      if (!match) throw new Error(`unsupported xpath step in test fixture: ${step}`);
      return { tag: match[1]?.toUpperCase(), idx: Number(match[2]) };
    });
  let current: HappyDomElement | null = root;
  for (const step of steps.slice(1)) {
    if (!current) return null;
    const candidates: HappyDomElement[] = Array.from(current.children).filter(
      (c: HappyDomElement) => c.tagName === step.tag
    );
    current = candidates[step.idx - 1] ?? null;
  }
  return current;
}

function buildFixture(landingUrl: string) {
  const window = new Window({ url: BASE_URL });
  const document = window.document;
  document.body.innerHTML = `
    <div class="preferencesFooter">
      <a id="subscribeLink" href="#">Manage subscription</a>
    </div>
  `;

  const subscribeEl = document.getElementById("subscribeLink") as unknown as HappyDomElement;
  expect(subscribeEl).not.toBeNull();
  const subscribeXPath = absoluteXPathFor(subscribeEl);

  let clickActivations = 0;
  let currentUrl = BASE_URL;
  let currentTitle = "Preferences";
  (
    subscribeEl as unknown as {
      addEventListener: (type: string, cb: (ev: unknown) => void) => void;
    }
  ).addEventListener("click", () => {
    clickActivations += 1;
    // Only a page-wide HTML-byte delta and a URL bounce — no network call,
    // no element-scoped selection-state change (the resolved element is a
    // plain `<a>`, never a real checkbox input), keeping the fallback's
    // `retryVerdict` disjunct the only path that could credit the click.
    currentUrl = landingUrl;
    currentTitle = landingUrl.includes("/login") ? "Sign In" : "Preferences Saved";
    document.body.innerHTML += `<div id="grown">${"x".repeat(600)}</div>`;
  });

  const documentElement = document.documentElement as unknown as HappyDomElement;
  const win = window as unknown as { XPathResult?: unknown };
  win.XPathResult = { FIRST_ORDERED_NODE_TYPE: 9 };
  (document as unknown as { evaluate: (expr: string) => { singleNodeValue: unknown } }).evaluate = (
    expr: string
  ) => {
    const node = expr.startsWith("//") ? null : resolveAbsoluteXPath(documentElement, expr);
    return { singleNodeValue: node };
  };

  const session = { on: () => {}, off: () => {} };
  const page: Page = {
    evaluate: async (expr: unknown): Promise<unknown> => {
      const src = String(expr);
      const fn = new window.Function("document", "XPathResult", `return (${src});`) as (
        d: unknown,
        x: unknown
      ) => unknown;
      return fn(document, win.XPathResult);
    },
    url: () => currentUrl,
    title: async () => currentTitle,
    // Forces attemptN16TrustedClick down its outer catch and into the
    // synthetic el.click() fallback — same precondition as
    // flow-runner.trusted-click-throw-wrong-destination-veto-acceptance.test.ts.
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

  const stagehand: Stagehand = {
    act: vi.fn().mockResolvedValue({
      success: true,
      message: "clicked",
      actionDescription: CHECKBOX_STEP,
      actions: [
        {
          selector: `xpath=${subscribeXPath}`,
          description: "Manage subscription",
          method: "click",
        },
      ],
    }),
    observe: vi
      .fn()
      .mockImplementation(async (instruction?: unknown) =>
        typeof instruction === "string"
          ? []
          : [{ selector: "xpath=//probe-presence", description: "probe-presence" }]
      ),
  } as unknown as Stagehand;

  return { page, stagehand, getClickActivations: () => clickActivations };
}

function baseHealingArgs(page: Page, stagehand: Stagehand) {
  return {
    stagehand,
    page,
    step: CHECKBOX_STEP,
    optional: false,
    upload: false,
    submitStep: false,
    flowHasSubmitSemantics: false,
    stepIndex: 0,
    totalSteps: () => 1,
    phase: "flow",
    signalCounter: { n: 0 },
    recentCaptures: [],
    recentCaptureMeta: [],
    anthropic: null,
    rephraseModel: null,
    logger: testLogger,
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
  };
}

describe("flow-runner n+16 fallback — classifyPhantomClick retryVerdict disjunct destination veto (offline fixture, live happy-dom, no network)", () => {
  it("does not credit the fallback via retryVerdict==='effective' on a byte-delta-only click that bounces to a sign-in-shaped destination for a non-sign-in checkbox step", async () => {
    const { page, stagehand, getClickActivations } = buildFixture("https://shop.example.com/login");
    const attemptsByFailure: AttemptRecord[][] = [];

    await expect(
      executeStepWithHealing({
        ...baseHealingArgs(page, stagehand),
        onStepFailure: ({ attempts }: { attempts: AttemptRecord[] }) => {
          attemptsByFailure.push(attempts);
          return null;
        },
      } as never)
    ).rejects.toThrow(/verification|attempts/i);

    expect(getClickActivations()).toBeGreaterThan(0);
    expect(attemptsByFailure.length).toBeGreaterThan(0);
    expect((attemptsByFailure[0] ?? []).length).toBeGreaterThan(0);

    // A page-wide HTML-byte delta alone must not credit the fallback via
    // classifyPhantomClick's retryVerdict==="effective" disjunct when the
    // landed destination is sign-in-shaped but the step was never about
    // signing in — on ANY attempt.
    for (const attempt of attemptsByFailure[0] ?? []) {
      expect(attempt.verifiedBy).not.toBe("dom");
    }
  });

  it("still credits the fallback via retryVerdict==='effective' on the identical byte-delta shape when the landed destination is plausible for the step (regression control)", async () => {
    const { page, stagehand, getClickActivations } = buildFixture(
      "https://shop.example.com/account/preferences/saved"
    );
    const attemptsByFailure: AttemptRecord[][] = [];

    await executeStepWithHealing({
      ...baseHealingArgs(page, stagehand),
      onStepFailure: ({ attempts }: { attempts: AttemptRecord[] }) => {
        attemptsByFailure.push(attempts);
        return null;
      },
    } as never);

    expect(getClickActivations()).toBeGreaterThan(0);
    expect(attemptsByFailure.length).toBe(0);
  });
});
