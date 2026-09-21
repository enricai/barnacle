import type { Page, Stagehand } from "@browserbasehq/stagehand";
import type { Element as HappyDomElement } from "happy-dom";
import { Window } from "happy-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { type HealingFlowStep, runHealingFlow } from "@/scraper/flow-runner";
import type { Logger } from "@/types/logging";

/**
 * Proves bugfix-001's `clickedElementStillPresent` veto
 * (recon-viewswap-false-pass-on-zero-signal-click.md) end-to-end through
 * `runHealingFlow`/`executeStepWithHealing` — not just the unit-level
 * `isClickViewSwapVerified` helper.
 *
 * An ordinary interior click (not submit, not the flow's final step) on a
 * generic settings wizard's "Advanced Options" toggle triggers a full
 * client-side RESET back to an earlier screen instead of the expected
 * same-page reveal: the reset removes the clicked button itself along with
 * everything else. The reset nets a byte delta well past
 * `VIEW_SWAP_MIN_BYTES` with zero network, zero URL change, and (because the
 * padding lives in a non-rendered attribute, not innerText) no visible-text
 * change and no tracked element-selection-fingerprint change either — the
 * exact "network=false url=false dom=false" shape the report describes.
 * Before bugfix-001, `isClickViewSwapVerified`'s directional byte-delta
 * credit alone would have scored this `verifiedBy: 'view-swap'`. The fix
 * threads `clickedElementStillPresent` (a live post-click xpath presence
 * probe) as a veto: the reset replaces the clicked control along with
 * everything else, so the probe reports `false` and the credit is withheld.
 * With no other candidate to fall back to, the step must exhaust every
 * cascade technique and fail loudly instead of silently completing.
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

  it("a click that resets the page (removing the clicked control) is NOT credited verifiedBy='view-swap' and the step fails verification instead of silently completing", async () => {
    const window = new Window({ url: BASE_URL });
    const document = window.document;
    document.body.innerHTML = `
      <div class="settingsWizard">
        <h1>Settings</h1>
        <button id="advancedOptionsBtn">Advanced Options</button>
        <div id="notificationsPanel"></div>
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
    // longer exists, so further clicks (there are none — nothing can find
    // it) have nothing left to do.
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

    const session = { on: () => {}, off: () => {} };
    // Every production `page.evaluate` expression (DOM snapshot, element
    // fingerprint read-back, the `clickedElementStillPresent` veto probe,
    // structured-click's checkable-input walk) runs FOR REAL against the
    // live happy-dom document via `window.Function` — nothing here
    // hand-simulates flow-runner.ts's internal verification logic.
    const page: Page = {
      evaluate: async (expr: unknown): Promise<unknown> => {
        const src = String(expr);
        const fn = new window.Function("document", "XPathResult", `return (${src});`) as (
          d: unknown,
          x: unknown
        ) => unknown;
        return fn(document, win.XPathResult);
      },
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
    // actually performs the reset. Clicking the button node when it's
    // already been removed from the DOM (every attempt after the first) is
    // a deliberate no-op, matching a real broken control that only ever
    // fires once.
    guardedAct.mockImplementation(async () => {
      const live = resolveAbsoluteXPath(documentElement, buttonXPath) as unknown as
        | { click?: () => void }
        | null;
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

    const STEPS: HealingFlowStep[] = [
      { instruction: STEP_INSTRUCTION, optional: false, upload: false, submitStep: false },
    ];

    await expect(
      runHealingFlow({
        stagehand,
        page,
        steps: STEPS,
        logger: testLogger,
        anthropic: null,
        rephraseModel: null,
        uploadFixture: null,
      })
    ).rejects.toThrow(/failed verification after \d+ attempts/);

    // The reset fired exactly once — proof the flow never silently
    // "completed" and moved on before exhausting the cascade.
    expect(resetCount).toBe(1);

    // Never credited as a view-swap (or any other) verification.
    const allLogged = [...SILENT_LOGGER_CALLS.info, ...SILENT_LOGGER_CALLS.warn].join("\n");
    expect(allLogged).not.toContain("verifiedBy: 'view-swap'");
    expect(SILENT_LOGGER_CALLS.info.some((line) => line.includes("succeeded on attempt"))).toBe(
      false
    );
    expect(SILENT_LOGGER_CALLS.info.some((line) => line.includes("healed on attempt"))).toBe(
      false
    );
  });
});
