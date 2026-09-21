import type { Page, Stagehand } from "@browserbasehq/stagehand";
import type { Element as HappyDomElement } from "happy-dom";
import { Window } from "happy-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
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
});
