import type { Page, Stagehand } from "@browserbasehq/stagehand";
import type { Element as HappyDomElement } from "happy-dom";
import { Window } from "happy-dom";
import { describe, expect, it, vi } from "vitest";
import { type HealingFlowStep, runHealingFlow } from "@/scraper/flow-runner";
import type { Logger } from "@/types/logging";

/**
 * Pins the report's core defect
 * (recon-browser-1.12.54-phantom-click-verdict-inconsistent-blocks-terminal-tab-toggle-steps-from-ever-completing.md)
 * in the shape neither existing acceptance regression exercises: a flow with
 * NO submit semantics anywhere (no step flagged `submitStep`, no
 * `submitEndpointPattern`) whose final step is an ordinary same-page tab
 * click that swaps a large sub-panel — one direction growing the DOM well
 * past the view-swap threshold, the structurally identical reverse click
 * shrinking it by a similar magnitude — and NEITHER tab exposes any tracked
 * ARIA/class/data-state selection marker (`ElementSelectionFingerprint`'s
 * fields all stay blank on both tabs), so the cascade must fall back
 * entirely on the page-wide DOM-size signal.
 *
 * (Confirmed by direct probe: threading a flow-wide `submitEndpointPattern`
 * through this same fixture does NOT reproduce the defect — the n+16
 * `el.click()` fallback's `weakDomSignalsAllowed` gate at flow-runner.ts
 * ORs in `requireSubmitEndpoint` (`(isFinalStep || submitStep) &&
 * submitEndpointPattern !== null`), which credits ANY nonzero byte delta,
 * including negative, once a pattern is configured. That is a real, separate
 * over-permissive gap — `requireSubmitEndpoint` still keys on raw
 * `isFinalStep` rather than the `flowHasSubmitSemantics`-aware derivation
 * `isSubmitShapedStep` uses elsewhere — but it happens to mask THIS report's
 * symptom rather than reproduce it, so this fixture omits
 * `submitEndpointPattern` entirely to isolate the reported defect.)
 *
 * With no submit semantics anywhere, `flowHasSubmitSemantics` is false, so
 * `isClickViewSwapVerified` is not final-step-excluded — but its directional
 * `bytesDelta >= VIEW_SWAP_MIN_BYTES` check (flow-runner.ts:1819) only
 * credits a POSITIVE delta. The n+16 fallback's `weakDomSignalsAllowed` is
 * ALSO false here (`requireSubmitEndpoint` false, and `isFinalStep` true), so
 * neither verifier has a rescue path for the final step's negative delta.
 * `classifyPhantomClick`'s own trivial-growth floor (`TRIVIAL_DOM_DELTA_BYTES`)
 * is equally one-directional. So the growing "Basic -> Premium" click (first
 * step) is credited by the view-swap gate, but the structurally identical
 * shrinking "Premium -> Basic" click (final step) never earns any positive
 * signal at all: no network, no URL, no element fingerprint change, and a
 * negative byte delta — the reported "alternating phantom/effective verdict"
 * shape, forcing an unnecessary escalation to attempt 2 on a click that
 * genuinely landed.
 *
 * Site-agnostic fixture: a generic two-tab pricing-plan switcher ("Basic" /
 * "Premium"), not any real site or plugin.
 *
 * Runs the real production expressions (`SELECTION_STATE_MAP_EXPR`,
 * `elementSelectionFingerprintExpr`, `DOM_SNAPSHOT_EXPR`) against a live
 * happy-dom document via `window.Function`, mirroring
 * `flow-runner.toggle-click-verdict-consistency-acceptance.test.ts` — no
 * internal helper is hand-simulated, only the DOM shape and the two tabs'
 * own click handlers.
 */

const BASE_URL = "https://pricing.example.com/plans";

const BASIC_TAB_STEP = "Click the 'Basic' plan tab to view its price";
const PREMIUM_TAB_STEP = "Click the 'Premium' plan tab to view its price";

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

function describeActInput(input: unknown): string {
  if (typeof input === "string") return input;
  try {
    return JSON.stringify(input);
  } catch {
    return "";
  }
}

describe("flow-runner pricing-tab symmetric grow/shrink swap verdict (offline fixture, live happy-dom, no network)", () => {
  it("completes both the growing and shrinking tab-toggle clicks on attempt 1 with no escalation, even with no tracked selection marker on either tab", async () => {
    const window = new Window({ url: BASE_URL });
    const document = window.document;
    document.body.innerHTML = `
      <div class="pricingTabs">
        <button id="basicTab">Basic</button>
        <button id="premiumTab">Premium</button>
        <div id="planPanel"></div>
      </div>
    `;

    const basicTabEl = document.getElementById("basicTab") as unknown as HappyDomElement;
    const premiumTabEl = document.getElementById("premiumTab") as unknown as HappyDomElement;
    expect(basicTabEl).not.toBeNull();
    expect(premiumTabEl).not.toBeNull();

    const basicXPath = absoluteXPathFor(basicTabEl);
    const premiumXPath = absoluteXPathFor(premiumTabEl);

    // Neither tab carries any ARIA/class/data-state selection marker — every
    // ElementSelectionFingerprint field (kind/cls/ariaPressed/ariaChecked/
    // ariaSelected/dataState/dataSelected/dataChecked/checked/value) stays
    // blank on both the pre- and post-click read-back for either button, so
    // `verifyDomEffect`'s element-scoped credit can never fire here — the
    // cascade is forced onto the page-wide DOM-size signal alone.
    const GROW_PADDING = "x".repeat(12_000);
    const SHRINK_PADDING = "x".repeat(6_000);

    // Basic tab's click handler: renders a big "Premium" feature comparison
    // panel — grows the DOM by +12000B, well past VIEW_SWAP_MIN_BYTES (5000).
    let basicClickCalls = 0;
    (
      basicTabEl as unknown as {
        addEventListener: (type: string, cb: (ev: unknown) => void) => void;
      }
    ).addEventListener("click", () => {
      basicClickCalls += 1;
      const panel = document.getElementById("planPanel");
      if (panel) panel.innerHTML = `<div data-plan-body="${GROW_PADDING}"></div>`;
    });

    // Premium tab's click handler: structurally identical swap in the
    // opposite direction — collapses the panel back down, shrinking the DOM
    // by -6000B (still well past VIEW_SWAP_MIN_BYTES in magnitude, but the
    // wrong sign for today's directional `bytesDelta >= VIEW_SWAP_MIN_BYTES`
    // check).
    let premiumClickCalls = 0;
    (
      premiumTabEl as unknown as {
        addEventListener: (type: string, cb: (ev: unknown) => void) => void;
      }
    ).addEventListener("click", () => {
      premiumClickCalls += 1;
      const panel = document.getElementById("planPanel");
      if (panel) panel.innerHTML = `<div data-plan-body="${SHRINK_PADDING}"></div>`;
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
    // Every production `page.evaluate` expression (the selection baseline
    // map, the element-scoped fingerprint read-back, the disabled-target
    // veto, the DOM snapshot) is executed FOR REAL against the live document
    // via `window.Function` — nothing here hand-simulates flow-runner.ts's
    // internal verification logic.
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
      title: async () => "Plans & Pricing",
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

    const stagehand: Stagehand = {
      act: vi.fn().mockImplementation(async (input: unknown) => {
        const description = describeActInput(input);
        if (description.includes("Basic")) {
          return {
            success: true,
            message: "clicked",
            actionDescription: BASIC_TAB_STEP,
            actions: [
              {
                selector: `xpath=${basicXPath}`,
                description: "Basic tab",
                method: "click",
              },
            ],
          };
        }
        if (description.includes("Premium")) {
          return {
            success: true,
            message: "clicked",
            actionDescription: PREMIUM_TAB_STEP,
            actions: [
              {
                selector: `xpath=${premiumXPath}`,
                description: "Premium tab",
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
      observe: vi
        .fn()
        .mockImplementation(async (instruction?: unknown) =>
          typeof instruction === "string"
            ? []
            : [{ selector: "xpath=//probe-presence", description: "probe-presence" }]
        ),
    } as unknown as Stagehand;

    const TOGGLE_STEPS: HealingFlowStep[] = [
      { instruction: BASIC_TAB_STEP, optional: false, upload: false, submitStep: false },
      { instruction: PREMIUM_TAB_STEP, optional: false, upload: false, submitStep: false },
    ];

    // No step is flagged `submitStep`, and the flow declares no
    // `submitEndpointPattern`/`requireSubmitEndpointMatch` at all — a
    // genuinely read-only flow, so `flowHasSubmitSemantics` is false and
    // NEITHER the primary view-swap gate nor the n+16 fallback's
    // weakDomSignalsAllowed override is final-step-excluded or
    // submit-endpoint-widened. The only signal available to either verifier
    // for the final step's shrinking click is the (one-directional) DOM-size
    // delta.
    const result = await runHealingFlow({
      stagehand,
      page,
      steps: TOGGLE_STEPS,
      logger: testLogger,
      anthropic: null,
      rephraseModel: null,
      uploadFixture: null,
    });

    expect(result.lastStepIndex).toBe(1);

    // Both toggle clicks actually fired, each exactly once — proving neither
    // step needed a retry/escalation to complete.
    expect(basicClickCalls).toBe(1);
    expect(premiumClickCalls).toBe(1);
    expect(stagehand.act).toHaveBeenCalledTimes(2);

    // Both attempts succeeded on the FIRST try.
    const succeededLines = SILENT_LOGGER_CALLS.info.filter((line) =>
      line.includes("succeeded on attempt 1")
    );
    expect(succeededLines).toHaveLength(2);
    expect(SILENT_LOGGER_CALLS.info.some((line) => line.includes("healed on attempt"))).toBe(false);

    // Neither step ever logged a "no observable effect" / escalation-shaped
    // warning (the phantom-click-escalation messages this bug's report
    // describes) — in particular the shrinking final-step click must not be
    // classified phantom just because its byte delta is negative.
    const allLogged = [...SILENT_LOGGER_CALLS.info, ...SILENT_LOGGER_CALLS.warn].join("\n");
    expect(allLogged).not.toContain("no observable effect");
    expect(allLogged).not.toContain("escalating attempt 2");
    expect(allLogged).not.toContain("phantom click");
  });
});
