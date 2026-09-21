import type { Page, Stagehand } from "@browserbasehq/stagehand";
import type { Element as HappyDomElement } from "happy-dom";
import { Window } from "happy-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { StepVerificationError } from "@/scraper/errors";
import { type AttemptRecord, executeStepWithHealing } from "@/scraper/flow-runner";
import type { FrameTarget } from "@/scraper/frame-target";
import type { Logger } from "@/types/logging";

/**
 * Proves bugfix-001's `clickedElementStillPresent` veto
 * (recon-viewswap-false-pass-on-zero-signal-click.md) end-to-end through
 * `executeStepWithHealing` — not just the unit-level `isClickViewSwapVerified`
 * helper.
 *
 * An ordinary interior click (not submit, not the flow's final step) on a
 * generic settings wizard's "Advanced Options" toggle triggers a full
 * client-side RESET back to an earlier screen instead of the expected
 * same-page reveal: the reset removes the clicked button itself along with
 * everything else. The reset nets a byte delta well past
 * `VIEW_SWAP_MIN_BYTES` with zero network, zero URL change, and (the padding
 * lives in a non-rendered attribute, not innerText) no visible-text change
 * either — the exact "network=false url=false dom=false" shape the report
 * describes ("dom" there is the element-scoped `domVerified` fingerprint
 * signal, which also reads false since the clicked element is gone).
 *
 * Before bugfix-001, `isClickViewSwapVerified`'s directional byte-delta
 * credit alone would have scored this attempt `trajectory[].verifiedBy:
 * 'view-swap'` on attempt 1, with NO fallback needed. The fix threads
 * `clickedElementStillPresent` (a live post-click xpath presence probe) as a
 * veto: the reset replaces the clicked control along with everything else,
 * so the probe reports `false` and the view-swap credit is withheld — the
 * primary gate demonstrably fails (proven by the `n+16 el.click() fallback`
 * diagnostic engaging at all, which only runs once the primary gate has
 * already rejected the attempt) and no attempt is ever credited
 * `verifiedBy: 'view-swap'`.
 *
 * (A large page-wide byte delta that survives the primary gate's veto is
 * still picked up by the executeStepWithHealing `el.click()` n+16 fallback's
 * OWN, separate weak-signal heuristic — a raw nonzero page-wide byte delta,
 * un-gated by `clickedElementStillPresent` — which is a distinct mechanism
 * bugfix-001 does not touch. This test scopes its assertions to the
 * `isClickViewSwapVerified` credit path bugfix-001 actually changed: the
 * click is never `verifiedBy: 'view-swap'`, and the primary gate provably
 * rejects it (forcing the fallback to engage at all) — the report's exact
 * defect.)
 *
 * Generic, site-agnostic fixture: a two-panel "Settings" wizard, not any
 * real site or plugin.
 */

const BASE_URL = "https://settings.example.com/preferences";
const STEP_INSTRUCTION = "Click the 'Advanced Options' button to reveal more settings";

const guardedObserve = vi.fn();
const guardedAct = vi.fn();

vi.mock("@/scraper/stagehand-guard", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/scraper/stagehand-guard")>();
  return {
    ...actual,
    guardedObserve: (...args: unknown[]) => guardedObserve(...args),
    guardedAct: (...args: unknown[]) => guardedAct(...args),
  };
});

const SILENT_LOGGER_CALLS = { info: [] as string[], warn: [] as string[] };
const testLogger = {
  info: vi.fn((msg: string) => SILENT_LOGGER_CALLS.info.push(msg)),
  warn: vi.fn((msg: string) => SILENT_LOGGER_CALLS.warn.push(msg)),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

/** Mirrors Stagehand's `nodeToAbsoluteXPath`: pure tag+sibling-position steps. */
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

describe("flow-runner view-swap zero-forward-signal click veto (offline fixture, live happy-dom, no network)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    SILENT_LOGGER_CALLS.info.length = 0;
    SILENT_LOGGER_CALLS.warn.length = 0;
  });

  it("a click that resets the page (removing the clicked control) is NOT credited verifiedBy='view-swap', and the primary view-swap gate demonstrably rejects it", async () => {
    const window = new Window({ url: BASE_URL });
    const document = window.document;
    document.body.innerHTML = `
      <div class="settingsWizard">
        <h1>Settings</h1>
        <button id="advancedOptionsBtn" aria-label="Advanced Options"></button>
      </div>
    `;

    const buttonEl = document.getElementById("advancedOptionsBtn") as unknown as HappyDomElement;
    expect(buttonEl).not.toBeNull();
    const buttonXPath = absoluteXPathFor(buttonEl);

    // Padding lives in a non-rendered attribute (not innerText), so the
    // reset's huge byte delta does NOT flip `textChanged` — isolating the
    // report's exact "network=false url=false dom=false" shape from the
    // OTHER (already-fixed) reveal branch that requires textChanged.
    const RESET_PADDING = "x".repeat(12_000);

    // The button's click handler performs a full client-side RESET: it
    // replaces the ENTIRE body (including the button itself) with an
    // earlier "Welcome" screen — a page-wide, untargeted content swap with
    // no evidence it originated from the clicked control, mirroring the
    // report's page-reset shape. Idempotent: once reset, the button no
    // longer exists, so a re-click attempt is a deliberate no-op.
    let resetCount = 0;
    (
      buttonEl as unknown as {
        addEventListener: (type: string, cb: (ev: unknown) => void) => void;
      }
    ).addEventListener("click", () => {
      resetCount += 1;
      document.body.innerHTML = `<div class="welcomeScreen" data-reset-padding="${RESET_PADDING}"><h1>Settings</h1></div>`;
    });

    const documentElement = document.documentElement as unknown as HappyDomElement;
    const win = window as unknown as { XPathResult?: unknown };
    win.XPathResult = { FIRST_ORDERED_NODE_TYPE: 9 };
    (document as unknown as { evaluate: (expr: string) => { singleNodeValue: unknown } }).evaluate =
      (expr: string) => {
        const node = expr.startsWith("//") ? null : resolveAbsoluteXPath(documentElement, expr);
        return { singleNodeValue: node };
      };

    // Every production `frameTarget.evaluate` expression (DOM snapshot,
    // element fingerprint read-back, the `clickedElementStillPresent` veto
    // probe, the n+16 fallback's own re-click) runs FOR REAL against the
    // live happy-dom document via `window.Function` — nothing here
    // hand-simulates flow-runner.ts's internal verification logic.
    const evaluateImpl = async (expr: unknown): Promise<unknown> => {
      const src = String(expr);
      const fn = new window.Function("document", "XPathResult", `return (${src});`) as (
        d: unknown,
        x: unknown
      ) => unknown;
      return fn(document, win.XPathResult);
    };

    const frameTarget: FrameTarget = {
      frame: undefined,
      frameSelector: undefined,
      evaluate: evaluateImpl,
      locator: () => ({
        first: () => ({
          isChecked: async () => false,
          inputValue: async () => "",
        }),
      }),
      url: () => Promise.resolve(BASE_URL),
      title: () => Promise.resolve("Settings"),
    } as unknown as FrameTarget;

    const session = { on: () => {}, off: () => {} };
    const page: Page = {
      evaluate: evaluateImpl,
      url: () => BASE_URL,
      title: async () => "Settings",
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

    const stagehand: Stagehand = {} as unknown as Stagehand;

    // guardedAct/guardedObserve are mocked directly so every cascade
    // attempt (act-string, observe-act, observe-act-exclude, llm-rephrase)
    // resolves the SAME button xpath — the click handler above is what
    // actually performs the reset. Clicking the button node once it's
    // already been removed from the DOM (every attempt after the first) is
    // a deliberate no-op, matching a real broken control that only ever
    // fires once.
    guardedAct.mockImplementation(async () => {
      const live = resolveAbsoluteXPath(documentElement, buttonXPath) as unknown as {
        click?: () => void;
      } | null;
      live?.click?.();
      return {
        success: true,
        message: "clicked",
        actionDescription: STEP_INSTRUCTION,
        actions: [
          {
            selector: `xpath=${buttonXPath}`,
            description: "Advanced Options button",
            method: "click",
          },
        ],
      };
    });
    guardedObserve.mockResolvedValue([
      {
        selector: `xpath=${buttonXPath}`,
        description: "Advanced Options button",
        method: "click",
      },
    ]);

    const trajectory: { stepIndex: number; verifiedBy: AttemptRecord["verifiedBy"] }[] = [];

    const result = await executeStepWithHealing({
      stagehand,
      page,
      frameTarget,
      step: STEP_INSTRUCTION,
      optional: false,
      upload: false,
      submitStep: false,
      flowHasSubmitSemantics: false,
      stepIndex: 0,
      totalSteps: () => 3,
      phase: "flow",
      signalCounter: { n: 0 },
      recentCaptures: [],
      recentCaptureMeta: [],
      anthropic: null,
      rephraseModel: null,
      logger: testLogger,
      uploadFixture: null,
      // Interior step: neither the flow's submit action nor its final step —
      // the exact shape the report's two reproductions both had.
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
      trajectory,
      onStepFailure: () => null,
    });

    // Something DID eventually resolve the step (via the n+16 fallback's own
    // separate weak-signal heuristic — see the module docblock above); the
    // point under test is HOW it resolved, not whether it did.
    expect(result).toBe("completed");

    // The reset fired exactly once.
    expect(resetCount).toBe(1);

    // The report's exact defect: never credited `verifiedBy: 'view-swap'`.
    expect(trajectory).toHaveLength(1);
    expect(trajectory[0]?.verifiedBy).not.toBe("view-swap");

    // Proof the PRIMARY view-swap gate itself rejected the attempt (not just
    // that some OTHER signal happened to win): the n+16 `el.click()`
    // fallback diagnostic only runs once the primary gate has already
    // failed to verify — see flow-runner.ts's `if (!verified && ...)` guard
    // immediately preceding it. Its presence in the log is direct evidence
    // `isClickViewSwapVerified` returned `false` for this attempt despite
    // the byte delta alone (11800+ bytes) comfortably clearing
    // `VIEW_SWAP_MIN_BYTES` — the exact credit bugfix-001's
    // `clickedElementStillPresent` veto withholds.
    expect(SILENT_LOGGER_CALLS.info.some((line) => line.includes("n+16 probe"))).toBe(true);

    // No attempt was ever logged as verified via the primary gate's
    // view-swap signal.
    const allLogged = [...SILENT_LOGGER_CALLS.info, ...SILENT_LOGGER_CALLS.warn].join("\n");
    expect(allLogged).not.toContain("verifiedBy=view-swap");
  });

  /**
   * Absorbed from test-001: an ordinary interior click on a truly dead
   * control — no network activity, no URL change, no element-fingerprint DOM
   * change, no page-wide raw-HTML byte change, and no visible-text change.
   * Unlike the reset scenario above, the clicked button is NEVER removed —
   * it silently does nothing on every attempt, so every one of `verifyDomEffect`,
   * `isClickViewSwapVerified`, and the n+16 fallback's own weak-signal OR-branch
   * see an IDENTICAL zero-delta pre/post pair on every attempt. `dom(raw)`
   * (the page-wide `bodyHtmlLength` the n+16 fallback's `htmlDelta` reads)
   * reports no change here too — the exact "network=false url=false
   * dom(raw)=false text=false" shape required item 'Tighten view-swap
   * verification to require at least one of network/URL/DOM signal to be
   * true' targets. With nothing to credit at ANY tier (no magnitude for
   * `isClickViewSwapVerified`'s byte-delta branch, no `classifyPhantomClick`
   * ≥500B floor, no weak OR-branch signal for the n+16 fallback), the
   * cascade genuinely exhausts all `MAX_STEP_ATTEMPTS` and
   * `executeStepWithHealing` throws `StepVerificationError` — the step does
   * NOT silently "complete".
   */
  it("a click on a dead control (zero network/URL/DOM-raw/text delta) is NOT credited verifiedBy='view-swap' and the step does not silently complete", async () => {
    const window = new Window({ url: BASE_URL });
    const document = window.document;
    document.body.innerHTML = `
      <div class="settingsWizard">
        <h1>Settings</h1>
        <button id="advancedOptionsBtn" aria-label="Advanced Options"></button>
      </div>
    `;

    const buttonEl = document.getElementById("advancedOptionsBtn") as unknown as HappyDomElement;
    expect(buttonEl).not.toBeNull();
    const buttonXPath = absoluteXPathFor(buttonEl);

    // The button is a genuinely dead control: its click handler does
    // nothing — no DOM mutation, no navigation, no fetch. Every attempt
    // (act-string, observe-act, observe-act-exclude, the n+16 fallback's own
    // el.click()) resolves the SAME still-present element and clicks it,
    // and nothing ever changes.
    let clickCount = 0;
    (
      buttonEl as unknown as {
        addEventListener: (type: string, cb: (ev: unknown) => void) => void;
      }
    ).addEventListener("click", () => {
      clickCount += 1;
    });

    const documentElement = document.documentElement as unknown as HappyDomElement;
    const win = window as unknown as { XPathResult?: unknown };
    win.XPathResult = { FIRST_ORDERED_NODE_TYPE: 9 };
    (document as unknown as { evaluate: (expr: string) => { singleNodeValue: unknown } }).evaluate =
      (expr: string) => {
        const node = expr.startsWith("//") ? null : resolveAbsoluteXPath(documentElement, expr);
        return { singleNodeValue: node };
      };

    // Every production `frameTarget.evaluate` expression runs FOR REAL
    // against the live happy-dom document via `window.Function` — nothing
    // here hand-simulates flow-runner.ts's internal verification logic.
    const evaluateImpl = async (expr: unknown): Promise<unknown> => {
      const src = String(expr);
      const fn = new window.Function("document", "XPathResult", `return (${src});`) as (
        d: unknown,
        x: unknown
      ) => unknown;
      return fn(document, win.XPathResult);
    };

    const frameTarget: FrameTarget = {
      frame: undefined,
      frameSelector: undefined,
      evaluate: evaluateImpl,
      locator: () => ({
        first: () => ({
          isChecked: async () => false,
          inputValue: async () => "",
        }),
      }),
      url: () => Promise.resolve(BASE_URL),
      title: () => Promise.resolve("Settings"),
    } as unknown as FrameTarget;

    const session = { on: () => {}, off: () => {} };
    const page: Page = {
      evaluate: evaluateImpl,
      url: () => BASE_URL,
      title: async () => "Settings",
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

    const stagehand: Stagehand = {} as unknown as Stagehand;

    // Every cascade attempt resolves the SAME still-present button xpath and
    // clicks it — the handler above is a deliberate no-op every time.
    guardedAct.mockImplementation(async () => {
      const live = resolveAbsoluteXPath(documentElement, buttonXPath) as unknown as {
        click?: () => void;
      } | null;
      live?.click?.();
      return {
        success: true,
        message: "clicked",
        actionDescription: STEP_INSTRUCTION,
        actions: [
          {
            selector: `xpath=${buttonXPath}`,
            description: "Advanced Options button",
            method: "click",
          },
        ],
      };
    });
    guardedObserve.mockResolvedValue([
      {
        selector: `xpath=${buttonXPath}`,
        description: "Advanced Options button",
        method: "click",
      },
    ]);

    const trajectory: { stepIndex: number; verifiedBy: AttemptRecord["verifiedBy"] }[] = [];

    const call = executeStepWithHealing({
      stagehand,
      page,
      frameTarget,
      step: STEP_INSTRUCTION,
      optional: false,
      upload: false,
      submitStep: false,
      flowHasSubmitSemantics: false,
      stepIndex: 0,
      totalSteps: () => 3,
      phase: "flow",
      signalCounter: { n: 0 },
      recentCaptures: [],
      recentCaptureMeta: [],
      anthropic: null,
      rephraseModel: null,
      logger: testLogger,
      uploadFixture: null,
      // Interior step: neither the flow's submit action nor its final step.
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
      trajectory,
      onStepFailure: () => null,
    });

    // No signal anywhere at any tier: the cascade genuinely exhausts and
    // escalates to the existing retry/escalation path — a thrown
    // `StepVerificationError` — rather than silently completing.
    await expect(call).rejects.toBeInstanceOf(StepVerificationError);

    // The dead control was clicked on every attempt, never credited.
    expect(clickCount).toBeGreaterThan(0);

    // No attempt was ever credited `verifiedBy: 'view-swap'` (nor by any
    // other signal — nothing observable ever happened).
    expect(trajectory.some((t) => t.verifiedBy === "view-swap")).toBe(false);

    // The n+16 fallback engaged on every attempt (proof the primary gate
    // rejected every attempt too) and its own probe line shows
    // `verified=false` with a zero `htmlDelta` — the literal
    // "network=false url=false dom(raw)=false text=false" shape.
    const n16Lines = SILENT_LOGGER_CALLS.info.filter((line) => line.includes("n+16 probe"));
    expect(n16Lines.length).toBeGreaterThan(0);
    expect(n16Lines.every((line) => line.includes("verified=false"))).toBe(true);
    expect(n16Lines.every((line) => line.includes("htmlDelta=0"))).toBe(true);
    expect(n16Lines.every((line) => line.includes("textChanged=false"))).toBe(true);

    const allLogged = [...SILENT_LOGGER_CALLS.info, ...SILENT_LOGGER_CALLS.warn].join("\n");
    expect(allLogged).not.toContain("verifiedBy=view-swap");
  });

  /**
   * Pins `resolvedClickTargetStillPresent`'s fail-open contract
   * (flow-runner.ts:4078-4086): the presence probe must default to `true`
   * (never veto) whenever presence genuinely can't be determined, rather
   * than whenever it CAN be determined-and-is-false. A same-page toggle
   * whose resolved click selector isn't xpath-shaped (a plain CSS id
   * selector) drives `xpathBodyForEvaluate` to return `null`, so the probe
   * returns `true` without ever calling `evaluate` — and the genuine
   * same-page reveal that follows must still be credited
   * `verifiedBy: 'view-swap'`. A hypothetical fail-closed variant (default
   * flipped to `false`) would veto this credit outright, since the CSS
   * selector can never positively prove presence.
   */
  it("a same-page reveal whose resolved click selector is not xpath-shaped is still credited verifiedBy='view-swap'", async () => {
    const window = new Window({ url: BASE_URL });
    const document = window.document;
    document.body.innerHTML = `
      <div class="settingsWizard">
        <h1>Settings</h1>
        <button id="advancedOptionsBtn" aria-label="Advanced Options"></button>
      </div>
    `;

    const buttonEl = document.getElementById("advancedOptionsBtn") as unknown as HappyDomElement;
    expect(buttonEl).not.toBeNull();

    // A genuine same-page toggle: the button stays in the DOM and a large
    // reveal panel is appended alongside it, clearing VIEW_SWAP_MIN_BYTES.
    const REVEAL_PADDING = "x".repeat(6_000);
    let revealCount = 0;
    (
      buttonEl as unknown as {
        addEventListener: (type: string, cb: (ev: unknown) => void) => void;
      }
    ).addEventListener("click", () => {
      revealCount += 1;
      const panel = document.createElement("div");
      panel.setAttribute("class", "advancedPanel");
      panel.textContent = REVEAL_PADDING;
      document.querySelector(".settingsWizard")?.appendChild(panel);
    });

    const documentElement = document.documentElement as unknown as HappyDomElement;
    const win = window as unknown as { XPathResult?: unknown };
    win.XPathResult = { FIRST_ORDERED_NODE_TYPE: 9 };
    (document as unknown as { evaluate: (expr: string) => { singleNodeValue: unknown } }).evaluate =
      (expr: string) => {
        const node = expr.startsWith("//") ? null : resolveAbsoluteXPath(documentElement, expr);
        return { singleNodeValue: node };
      };

    const evaluateImpl = async (expr: unknown): Promise<unknown> => {
      const src = String(expr);
      const fn = new window.Function("document", "XPathResult", `return (${src});`) as (
        d: unknown,
        x: unknown
      ) => unknown;
      return fn(document, win.XPathResult);
    };

    const frameTarget: FrameTarget = {
      frame: undefined,
      frameSelector: undefined,
      evaluate: evaluateImpl,
      locator: () => ({
        first: () => ({
          isChecked: async () => false,
          inputValue: async () => "",
        }),
      }),
      url: () => Promise.resolve(BASE_URL),
      title: () => Promise.resolve("Settings"),
    } as unknown as FrameTarget;

    const session = { on: () => {}, off: () => {} };
    const page: Page = {
      evaluate: evaluateImpl,
      url: () => BASE_URL,
      title: async () => "Settings",
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

    const stagehand: Stagehand = {} as unknown as Stagehand;

    // The resolved action's selector is a plain CSS id selector — not
    // `xpath=`-prefixed and doesn't start with `/` or `(` — so
    // `xpathBodyForEvaluate` returns null and the presence probe can never
    // run.
    guardedAct.mockImplementation(async () => {
      const live = document.getElementById("advancedOptionsBtn") as unknown as {
        click?: () => void;
      } | null;
      live?.click?.();
      return {
        success: true,
        message: "clicked",
        actionDescription: STEP_INSTRUCTION,
        actions: [
          {
            selector: "#advancedOptionsBtn",
            description: "Advanced Options button",
            method: "click",
          },
        ],
      };
    });
    guardedObserve.mockResolvedValue([
      {
        selector: "#advancedOptionsBtn",
        description: "Advanced Options button",
        method: "click",
      },
    ]);

    const trajectory: { stepIndex: number; verifiedBy: AttemptRecord["verifiedBy"] }[] = [];

    const result = await executeStepWithHealing({
      stagehand,
      page,
      frameTarget,
      step: STEP_INSTRUCTION,
      optional: false,
      upload: false,
      submitStep: false,
      flowHasSubmitSemantics: false,
      stepIndex: 0,
      totalSteps: () => 3,
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
      trajectory,
      onStepFailure: () => null,
    });

    expect(result).toBe("completed");
    expect(revealCount).toBe(1);

    // The fail-open contract under test: presence couldn't be determined
    // (non-xpath selector), so the probe never vetoed, and the genuine
    // reveal is credited on the primary gate.
    expect(trajectory).toHaveLength(1);
    expect(trajectory[0]?.verifiedBy).toBe("view-swap");
  });

  /**
   * Pins `resolvedClickTargetStillPresent`'s other fail-open branch
   * (flow-runner.ts:4098-4099): when the presence-probe's own
   * `target.evaluate` call throws, the probe must default to `true` (never
   * veto) rather than treat the throw as proof of absence. The resolved
   * click selector stays xpath-shaped here — every OTHER `evaluate` call
   * (DOM snapshot, fingerprint read-back) still runs for real against the
   * live happy-dom document; only the presence probe's own distinguishing
   * expression throws.
   */
  it("a same-page reveal whose presence-probe evaluate call throws is still credited verifiedBy='view-swap'", async () => {
    const window = new Window({ url: BASE_URL });
    const document = window.document;
    document.body.innerHTML = `
      <div class="settingsWizard">
        <h1>Settings</h1>
        <button id="advancedOptionsBtn" aria-label="Advanced Options"></button>
      </div>
    `;

    const buttonEl = document.getElementById("advancedOptionsBtn") as unknown as HappyDomElement;
    expect(buttonEl).not.toBeNull();
    const buttonXPath = absoluteXPathFor(buttonEl);

    const REVEAL_PADDING = "x".repeat(6_000);
    let revealCount = 0;
    (
      buttonEl as unknown as {
        addEventListener: (type: string, cb: (ev: unknown) => void) => void;
      }
    ).addEventListener("click", () => {
      revealCount += 1;
      const panel = document.createElement("div");
      panel.setAttribute("class", "advancedPanel");
      panel.textContent = REVEAL_PADDING;
      document.querySelector(".settingsWizard")?.appendChild(panel);
    });

    const documentElement = document.documentElement as unknown as HappyDomElement;
    const win = window as unknown as { XPathResult?: unknown };
    win.XPathResult = { FIRST_ORDERED_NODE_TYPE: 9 };
    (document as unknown as { evaluate: (expr: string) => { singleNodeValue: unknown } }).evaluate =
      (expr: string) => {
        const node = expr.startsWith("//") ? null : resolveAbsoluteXPath(documentElement, expr);
        return { singleNodeValue: node };
      };

    // Every evaluate call runs for real EXCEPT the presence probe's own
    // distinguishing expression (matched by its exact literal template from
    // flow-runner.ts:4094), which throws to simulate a live evaluate
    // failure.
    const evaluateImpl = async (expr: unknown): Promise<unknown> => {
      const src = String(expr);
      if (src.includes("FIRST_ORDERED_NODE_TYPE") && src.includes("singleNodeValue !== null")) {
        throw new Error("simulated evaluate failure in presence probe");
      }
      const fn = new window.Function("document", "XPathResult", `return (${src});`) as (
        d: unknown,
        x: unknown
      ) => unknown;
      return fn(document, win.XPathResult);
    };

    const frameTarget: FrameTarget = {
      frame: undefined,
      frameSelector: undefined,
      evaluate: evaluateImpl,
      locator: () => ({
        first: () => ({
          isChecked: async () => false,
          inputValue: async () => "",
        }),
      }),
      url: () => Promise.resolve(BASE_URL),
      title: () => Promise.resolve("Settings"),
    } as unknown as FrameTarget;

    const session = { on: () => {}, off: () => {} };
    const page: Page = {
      evaluate: evaluateImpl,
      url: () => BASE_URL,
      title: async () => "Settings",
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

    const stagehand: Stagehand = {} as unknown as Stagehand;

    guardedAct.mockImplementation(async () => {
      const live = resolveAbsoluteXPath(documentElement, buttonXPath) as unknown as {
        click?: () => void;
      } | null;
      live?.click?.();
      return {
        success: true,
        message: "clicked",
        actionDescription: STEP_INSTRUCTION,
        actions: [
          {
            selector: `xpath=${buttonXPath}`,
            description: "Advanced Options button",
            method: "click",
          },
        ],
      };
    });
    guardedObserve.mockResolvedValue([
      {
        selector: `xpath=${buttonXPath}`,
        description: "Advanced Options button",
        method: "click",
      },
    ]);

    const trajectory: { stepIndex: number; verifiedBy: AttemptRecord["verifiedBy"] }[] = [];

    const result = await executeStepWithHealing({
      stagehand,
      page,
      frameTarget,
      step: STEP_INSTRUCTION,
      optional: false,
      upload: false,
      submitStep: false,
      flowHasSubmitSemantics: false,
      stepIndex: 0,
      totalSteps: () => 3,
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
      trajectory,
      onStepFailure: () => null,
    });

    expect(result).toBe("completed");
    expect(revealCount).toBe(1);

    // The fail-open contract under test: the probe's own evaluate call
    // threw, so presence couldn't be determined, and the genuine reveal is
    // still credited on the primary gate.
    expect(trajectory).toHaveLength(1);
    expect(trajectory[0]?.verifiedBy).toBe("view-swap");
  });
});
