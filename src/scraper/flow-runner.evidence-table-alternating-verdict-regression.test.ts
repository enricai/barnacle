import type { Page, Stagehand } from "@browserbasehq/stagehand";
import type { Element as HappyDomElement } from "happy-dom";
import { Window } from "happy-dom";
import { describe, expect, it, vi } from "vitest";
import { type HealingFlowStep, runHealingFlow } from "@/scraper/flow-runner";
import type { Logger } from "@/types/logging";

/**
 * Pins the exact numeric shape of the bug report's own evidence table
 * (recon-phantom-click-verdict-inconsistent-blocks-terminal-tab-toggle-steps-from-ever-completing.md),
 * rather than a same-shaped-but-different-fixture case: the report's attempt
 * 4 and attempt 5 rows show the element-scoped selection-state fingerprint
 * alternating between two hashed values (`6wlcrv:4` -> `43nch1:4`, then back)
 * paired with body-HTML byte deltas that are asymmetric in SIGN and both well
 * past the phantom-click "trivial" floor (`TRIVIAL_DOM_DELTA_BYTES` = 500 in
 * phantom-click.ts): attempt 4 grows the body by +10550B, attempt 5 shrinks
 * it by -3829B — a different magnitude, not a symmetric undo. Before the
 * flow-submit-semantics-scoped-to-actual-submit-step fix, the final step's
 * submit-shape derivation mis-keyed on `isFinalStep` alone, silently
 * suppressing the terminal toggle's baseline capture and collapsing its
 * verdict to `phantom` whenever ITS OWN byte delta (the negative one) didn't
 * independently cross the trivial floor in isolation from the element-scoped
 * signal. This test drives two non-submit-shaped toggle-click steps whose
 * fingerprint AND byte-delta signals both independently flip on every click,
 * asserting both classify `effective` and complete on attempt 1.
 *
 * Runs the real production expressions (`SELECTION_STATE_MAP_EXPR`,
 * `elementSelectionFingerprintExpr`, `DOM_SNAPSHOT_EXPR`) against a live
 * happy-dom document via `window.Function`, mirroring
 * `flow-runner.toggle-click-verdict-consistency-acceptance.test.ts` — no
 * internal helper is hand-simulated, only the DOM shape and the two tabs'
 * own click-commit handlers.
 *
 * Fails against the pre-fix commit (5763ac2~1 / a070c32~1): with that
 * derivation, the terminal Billing click's baseline capture is suppressed,
 * its -3829B-shaped delta doesn't independently cross the trivial floor, and
 * the element-scoped fingerprint swap is discarded for the final step —
 * collapsing its verdict to `phantom` and escalating instead of completing
 * on attempt 1.
 *
 * The pre-fix bug only manifests on a FLOW that has submit semantics
 * somewhere (`flowHasSubmitSemantics` gates on it) — a flow with no submit
 * step anywhere never enters the buggy branch pre- or post-fix, which is
 * indistinguishable from the fix actually working. So this flow leads with a
 * genuine, EARLIER `submitStep: true` step (a real URL-changing action,
 * unrelated to the two toggle clicks) — exactly the report's shape and the
 * shape `flowHasSubmitSemantics` targets: pre-fix, that earlier step's flag
 * makes `flowHasSubmitSemantics` true FLOW-WIDE and `isFinalStep &&
 * flowHasSubmitSemantics` then wrongly claims the terminal Billing toggle
 * too, even though its OWN `submitStep` is `false`. Post-fix, the flag is
 * authoritative only for the step that actually carries it, so the terminal
 * toggle is correctly left non-submit-shaped.
 */

const BASE_URL = "https://portal.example.net/app/preferences";

const SAVE_STEP = "Click the 'Save' button to persist the earlier form step";
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

describe("flow-runner evidence-table alternating-verdict regression (offline fixture, live happy-dom, no network)", () => {
  it("credits the report's own +10550B/-3829B byte-delta pair and alternating fingerprint swap identically on attempt 1, with no submit semantics anywhere", async () => {
    const window = new Window({ url: BASE_URL });
    const document = window.document;
    document.body.innerHTML = `
      <div class="formWidget">
        <button type="button" id="saveButton">Save</button>
      </div>
      <div class="tabWidget">
        <div role="listbox"></div>
        <input type="hidden" id="tabSupportState" class="opt-idle" />
        <input type="hidden" id="tabBillingState" class="opt-idle" />
      </div>
    `;

    const saveButtonEl = document.getElementById("saveButton") as unknown as HappyDomElement;
    expect(saveButtonEl).not.toBeNull();
    const saveXPath = absoluteXPathFor(saveButtonEl);

    // The earlier step's own click-commit handler: a real URL-changing
    // submission, unrelated to either toggle click below — the ONLY thing
    // that matters is that this step carries `submitStep: true` so
    // `flowHasSubmitSemantics` sees a flagged step in the flow at all.
    let saveClickCalls = 0;
    let currentUrl = BASE_URL;
    (
      saveButtonEl as unknown as {
        addEventListener: (type: string, cb: (ev: unknown) => void) => void;
      }
    ).addEventListener("click", () => {
      saveClickCalls += 1;
      currentUrl = `${BASE_URL}?saved=1`;
    });

    const supportInputEl = document.getElementById("tabSupportState") as unknown as HappyDomElement;
    const billingInputEl = document.getElementById("tabBillingState") as unknown as HappyDomElement;
    expect(supportInputEl).not.toBeNull();
    expect(billingInputEl).not.toBeNull();

    const supportXPath = absoluteXPathFor(supportInputEl);
    const billingXPath = absoluteXPathFor(billingInputEl);

    // Sized directly off the report's evidence table: attempt 4's +10550B
    // growth node, always inserted (and never removed) by the Support click.
    const GROWTH_PADDING = "x".repeat(10550);
    // A decoy node present at baseline, sized off the report's attempt 5
    // -3829B row. Removed only by the Billing click — a DIFFERENT node than
    // the one the Support click inserts, so the two deltas are asymmetric in
    // both sign and magnitude, not a symmetric add/undo pair.
    const decoyPad = document.createElement("div");
    decoyPad.setAttribute("id", "decoyPad");
    decoyPad.setAttribute("hidden", "true");
    decoyPad.setAttribute("data-pad", "y".repeat(3829));
    document.body.appendChild(decoyPad);

    // The Support tab's own click-commit handler: swaps its own tracked
    // `class` fingerprint field from the shared "opt-idle" baseline to a
    // hashed-looking selected token (mirrors the report's `6wlcrv:4` state),
    // and inserts the +10550B growth node — mirrors the report's "attempt 4:
    // +10550B" positive-delta toggle.
    let supportClickCalls = 0;
    (
      supportInputEl as unknown as {
        addEventListener: (type: string, cb: (ev: unknown) => void) => void;
      }
    ).addEventListener("click", () => {
      supportClickCalls += 1;
      supportInputEl.setAttribute("class", "opt-6wlcrv");
      const pad = document.createElement("div");
      pad.setAttribute("id", "growthPad");
      pad.setAttribute("hidden", "true");
      pad.setAttribute("data-pad", GROWTH_PADDING);
      document.body.appendChild(pad);
    });

    // The Billing tab's own click-commit handler: swaps its own tracked
    // `class` fingerprint field to a DIFFERENT hashed-looking selected token
    // (mirrors the report's `43nch1:4` state — the alternating swap away
    // from the Support click's value), and removes the pre-existing
    // -3829B decoy node — mirrors the report's "attempt 5: -3829B"
    // negative-delta toggle, the exact case the pre-fix derivation
    // misclassified as phantom on the final step.
    let billingClickCalls = 0;
    (
      billingInputEl as unknown as {
        addEventListener: (type: string, cb: (ev: unknown) => void) => void;
      }
    ).addEventListener("click", () => {
      billingClickCalls += 1;
      billingInputEl.setAttribute("class", "opt-43nch1");
      document.getElementById("decoyPad")?.remove();
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
      url: () => currentUrl,
      title: async () => "Account Preferences",
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
        if (description.includes("Save")) {
          return {
            success: true,
            message: "clicked",
            actionDescription: SAVE_STEP,
            actions: [
              {
                selector: `xpath=${saveXPath}`,
                description: "Save button",
                method: "click",
              },
            ],
          };
        }
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

    const MIXED_STEPS: HealingFlowStep[] = [
      { instruction: SAVE_STEP, optional: false, upload: false, submitStep: true },
      { instruction: SUPPORT_TAB_STEP, optional: false, upload: false, submitStep: false },
      { instruction: BILLING_TAB_STEP, optional: false, upload: false, submitStep: false },
    ];

    // An earlier step carries `submitStep: true` (a real URL-changing
    // action) so the flow HAS submit semantics somewhere — the exact
    // condition the pre-fix `isFinalStep`-only derivation mishandled. Both
    // the interior Support click and the terminal Billing click must still
    // be recognized as non-submit-shaped, since neither carries its own
    // `submitStep` flag.
    const result = await runHealingFlow({
      stagehand,
      page,
      steps: MIXED_STEPS,
      logger: testLogger,
      anthropic: null,
      rephraseModel: null,
      uploadFixture: null,
      submitEndpointPattern: null,
      requireSubmitEndpointMatch: false,
    });

    expect(result.lastStepIndex).toBe(2);

    // All three clicks actually fired, each exactly once — proving no step
    // needed a retry/escalation to complete.
    expect(saveClickCalls).toBe(1);
    expect(supportClickCalls).toBe(1);
    expect(billingClickCalls).toBe(1);
    expect(stagehand.act).toHaveBeenCalledTimes(3);

    // Both committed their own state — the authoritative signal — and the
    // fingerprint really did alternate between two DIFFERENT hashed-looking
    // values, not just flip a boolean.
    expect(supportInputEl.getAttribute("class")).toBe("opt-6wlcrv");
    expect(billingInputEl.getAttribute("class")).toBe("opt-43nch1");
    // The Support click's growth node survives; the pre-existing decoy the
    // Billing click removed is gone — proving the two deltas really did come
    // from different nodes with opposite-signed, non-undoing magnitudes.
    expect(document.getElementById("growthPad")).not.toBeNull();
    expect(document.getElementById("decoyPad")).toBeNull();

    // Both attempts succeeded on the FIRST try — never a multi-attempt heal —
    // and no step was ever classified as a no-op click.
    const succeededLines = SILENT_LOGGER_CALLS.info.filter((line) =>
      line.includes("succeeded on attempt 1")
    );
    expect(succeededLines).toHaveLength(3);
    expect(SILENT_LOGGER_CALLS.info.some((line) => line.includes("healed on attempt"))).toBe(false);

    const allLogged = [...SILENT_LOGGER_CALLS.info, ...SILENT_LOGGER_CALLS.warn].join("\n");
    expect(allLogged).not.toContain("not treating as verified");
    expect(allLogged).not.toContain("phantom click");
    expect(allLogged).not.toContain("escalating attempt 2");
  });
});
