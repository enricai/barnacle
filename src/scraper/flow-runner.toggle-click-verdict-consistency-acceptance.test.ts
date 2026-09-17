import type { Page, Stagehand } from "@browserbasehq/stagehand";
import type { Element as HappyDomElement } from "happy-dom";
import { Window } from "happy-dom";
import { describe, expect, it, vi } from "vitest";
import { type HealingFlowStep, runHealingFlow } from "@/scraper/flow-runner";
import type { Logger } from "@/types/logging";

/**
 * Pins the report's core inconsistency
 * (recon-phantom-click-verdict-inconsistent-blocks-terminal-tab-toggle-steps-from-ever-completing.md):
 * two same-page toggle clicks of the same kind (switching between two tabs)
 * must verify identically once both are correctly recognized as
 * non-submit-shaped, regardless of the sign/magnitude of the incidental
 * page-wide `bodyHtmlLength` delta each produces. One toggle's click grows
 * the body past the phantom-click "trivial" byte floor (500B, see
 * `TRIVIAL_DOM_DELTA_BYTES` in phantom-click.ts) via an unrelated hidden
 * padding node; the other's shrinks it by removing that same node. Neither
 * delta crosses the (much higher) view-swap threshold (5000B), so the only
 * signal either click can be verified by is the authoritative, element-scoped
 * fingerprint change `verifyDomEffect` reads off the clicked control itself
 * (`data-selected` flipping "" -> "1") — which requires
 * `shouldCaptureSelectionState`/`isSubmitShapedStep` to correctly treat BOTH
 * steps (including the final one) as non-submit-shaped in a flow that
 * declares no submit semantics anywhere. Before the
 * flow-submit-semantics-scoped-to-actual-submit-step fix, the derivation
 * mis-keyed on `isFinalStep` alone, silently suppressing the final step's
 * baseline capture and collapsing its verdict to phantom whenever its byte
 * delta didn't independently cross the trivial floor — exactly the
 * negative-delta case here.
 *
 * Runs the real production expressions (`SELECTION_STATE_MAP_EXPR`,
 * `elementSelectionFingerprintExpr`, `DOM_SNAPSHOT_EXPR`) against a live
 * happy-dom document via `window.Function`, mirroring
 * `flow-runner.disabled-submit-blocked-by-uncommitted-selection.test.ts` —
 * no internal helper is hand-simulated, only the DOM shape and the two tabs'
 * own click-commit handlers.
 */

const BASE_URL = "https://dashboard.example.com/app/settings";

const SUPPORT_TAB_STEP = "Click the 'Support' tab to switch to it";
const BILLING_TAB_STEP = "Click the 'Billing' tab to switch to it";

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

describe("flow-runner toggle-click verdict consistency (offline fixture, live happy-dom, no network)", () => {
  it("credits both a positive-byte-delta and a negative-byte-delta toggle click identically via the element-scoped dom signal, on attempt 1, with no submit semantics anywhere in the flow", async () => {
    const window = new Window({ url: BASE_URL });
    const document = window.document;
    document.body.innerHTML = `
      <div class="tabWidget">
        <div role="listbox"></div>
        <input type="hidden" id="tabSupportState" />
        <input type="hidden" id="tabBillingState" />
      </div>
    `;

    const supportInputEl = document.getElementById("tabSupportState") as unknown as HappyDomElement;
    const billingInputEl = document.getElementById("tabBillingState") as unknown as HappyDomElement;
    expect(supportInputEl).not.toBeNull();
    expect(billingInputEl).not.toBeNull();

    const supportXPath = absoluteXPathFor(supportInputEl);
    const billingXPath = absoluteXPathFor(billingInputEl);

    // A large (~1500B) hidden padding node — big enough to cross the
    // phantom-click TRIVIAL_DOM_DELTA_BYTES floor (500) but well short of the
    // view-swap threshold (5000), and invisible to innerText, so it can never
    // ride the view-swap or text-reveal signals; only the element-scoped dom
    // credit can verify either click.
    const PADDING = "x".repeat(1500);

    // The Support tab's own click-commit handler: flips its own tracked
    // `data-selected` fingerprint field AND inserts the padding node —
    // mirrors the report's "attempt 4: +10550B" positive-delta toggle.
    let supportClickCalls = 0;
    (
      supportInputEl as unknown as {
        addEventListener: (type: string, cb: (ev: unknown) => void) => void;
      }
    ).addEventListener("click", () => {
      supportClickCalls += 1;
      supportInputEl.setAttribute("data-selected", "true");
      const pad = document.createElement("div");
      pad.setAttribute("id", "tabPadding");
      pad.setAttribute("hidden", "true");
      pad.setAttribute("data-pad", PADDING);
      document.body.appendChild(pad);
    });

    // The Billing tab's own click-commit handler: flips its own tracked
    // `data-selected` fingerprint field AND removes the padding node the
    // Support click inserted — mirrors the report's "attempt 5: -3829B"
    // negative-delta toggle, the case the pre-fix derivation misclassified.
    let billingClickCalls = 0;
    (
      billingInputEl as unknown as {
        addEventListener: (type: string, cb: (ev: unknown) => void) => void;
      }
    ).addEventListener("click", () => {
      billingClickCalls += 1;
      billingInputEl.setAttribute("data-selected", "true");
      const pad = document.getElementById("tabPadding");
      pad?.remove();
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
      title: async () => "Account Settings",
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
        if (description.includes("Support")) {
          return {
            success: true,
            message: "clicked",
            actionDescription: SUPPORT_TAB_STEP,
            actions: [
              {
                selector: `xpath=${supportXPath}`,
                description: "Support tab",
                method: "click",
              },
            ],
          };
        }
        if (description.includes("Billing")) {
          return {
            success: true,
            message: "clicked",
            actionDescription: BILLING_TAB_STEP,
            actions: [
              {
                selector: `xpath=${billingXPath}`,
                description: "Billing tab",
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
      { instruction: SUPPORT_TAB_STEP, optional: false, upload: false, submitStep: false },
      { instruction: BILLING_TAB_STEP, optional: false, upload: false, submitStep: false },
    ];

    // No submitStep, submitEndpointPattern, or requireSubmitEndpointMatch
    // anywhere — a genuinely read-only flow, so BOTH the interior Support
    // click and the terminal Billing click must be recognized as
    // non-submit-shaped, including the final one.
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
    expect(supportClickCalls).toBe(1);
    expect(billingClickCalls).toBe(1);
    expect(stagehand.act).toHaveBeenCalledTimes(2);

    // Both committed their own state — the authoritative signal.
    expect(supportInputEl.getAttribute("data-selected")).toBe("true");
    expect(billingInputEl.getAttribute("data-selected")).toBe("true");
    // The padding node the Support click grew the body by is gone again —
    // proving the Billing click's delta really was negative, not merely
    // small.
    expect(document.getElementById("tabPadding")).toBeNull();

    // Both attempts succeeded on the FIRST try via the authoritative
    // element-scoped `selectionStateChanged` credit — never a multi-attempt
    // heal, and never by riding the weak page-wide html/text delta (which
    // the n+16 probe's own log line proves by reporting selectionStateChanged
    // itself as the true positive signal on both toggles despite their
    // opposite-signed htmlDelta).
    const succeededLines = SILENT_LOGGER_CALLS.info.filter((line) =>
      line.includes("succeeded on attempt 1")
    );
    expect(succeededLines).toHaveLength(2);
    const n16ProbeLines = SILENT_LOGGER_CALLS.info.filter((line) => line.includes("n+16 probe:"));
    expect(n16ProbeLines).toHaveLength(2);
    for (const line of n16ProbeLines) {
      expect(line).toContain("selectionStateChanged=true");
      expect(line).toContain("verified=true");
    }
    // The two probes really do disagree in sign on the page-wide byte delta —
    // proving the consistent "effective" verdict came from the element-scoped
    // signal, not from both deltas happening to cross the same floor.
    const htmlDeltas = n16ProbeLines.map((line) => {
      const match = /htmlDelta=(-?\d+)/.exec(line);
      return match ? Number(match[1]) : Number.NaN;
    });
    expect(htmlDeltas[0]).toBeGreaterThan(500);
    expect(htmlDeltas[1]).toBeLessThan(0);
    expect(SILENT_LOGGER_CALLS.info.some((line) => line.includes("healed on attempt"))).toBe(false);

    // Neither step ever logged a "no observable effect"-shaped warning (the
    // advance-DOM-veto / view-swap-blocked / phantom-click-escalation
    // messages this bug's report describes).
    const allLogged = [...SILENT_LOGGER_CALLS.info, ...SILENT_LOGGER_CALLS.warn].join("\n");
    expect(allLogged).not.toContain("not treating as verified");
    expect(allLogged).not.toContain("phantom click");
  });
});
