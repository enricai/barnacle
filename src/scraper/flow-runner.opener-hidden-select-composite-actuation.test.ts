import type { Page, Stagehand } from "@browserbasehq/stagehand";
import type { Element as HappyDomElement, Window } from "happy-dom";
import { Window as HappyDomWindow } from "happy-dom";
import { describe, expect, it, vi } from "vitest";

import { executeStepWithHealing } from "@/scraper/flow-runner";
import type { FrameTarget } from "@/scraper/frame-target";
import type { Logger } from "@/types/logging";

/**
 * Pins required item 2 of the Base Web `bb-customSelect` recon report: the
 * actuation SEQUENCE for an opener+hidden-`<select>` composite must be
 * trusted-click the opener, wait for its `aria-owns` panel to expose
 * `aria-expanded="true"` before probing for options, then click the option
 * inside that panel whose text matches the target — never write the hidden
 * `<select>` directly and never look for an `<option>` under the visible
 * opener node (there are none in this widget shape). Isolated from detection
 * (`flow-runner.opener-hidden-select-composite-detection.test.ts`) and
 * verification (`flow-runner.opener-hidden-select-composite-committed-verify.test.ts`)
 * so a failure here can only be an actuation-sequence regression. Runs
 * against a live happy-dom document with real `addEventListener` delivery,
 * per `flow-runner.list-select-real-actuation.test.ts`'s technique — the
 * fixture's panel only attaches its option nodes once `aria-expanded` flips
 * true, mirroring Base Web's real timing, so a premature option probe fails.
 */

const testLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

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

function makeStagehand(): Stagehand {
  return {} as unknown as Stagehand;
}

function fakePage(): Page {
  return {
    evaluate: vi.fn().mockResolvedValue(null),
    locator: vi.fn().mockReturnValue({
      first: () => ({
        isChecked: vi.fn().mockResolvedValue(false),
        inputValue: vi.fn().mockResolvedValue(""),
      }),
    }),
    url: () => "https://careers.example.com/apply/job/1",
    title: vi.fn().mockResolvedValue("Apply"),
    waitForTimeout: vi.fn().mockResolvedValue(undefined),
  } as unknown as Page;
}

/**
 * Builds the report's exact widget shape, but — unlike the detection test's
 * fixture — the `aria-owns` panel's option `<li>` nodes are ONLY ATTACHED to
 * the DOM once `aria-expanded` flips to `"true"`; before that, the panel
 * element exists (referenced by `aria-owns`) but is empty. Any actuation
 * sequence that probes for options before genuinely waiting on the expanded
 * state finds nothing and cannot commit — a premature probe fails the test
 * by construction, closing the gap the detection fixture (which renders
 * options synchronously inside its own click handler) does not check.
 */
function buildOpenerHiddenSelectWidget(params: { fieldId: string; options: readonly string[] }): {
  window: Window;
  openerEl: HappyDomElement;
  hiddenSelect: { value: string };
  panelEl: HappyDomElement;
  openerClickCount: () => number;
  openerClickWasTrustedMouseEvent: () => boolean;
  optionClickCount: () => number;
} {
  const { fieldId, options } = params;
  const window = new HappyDomWindow({ url: "https://careers.example.com/apply/job/1" });
  const document = window.document;
  const optionsHtml = options
    .map((text) => `<option value="${text.toLowerCase().replace(/\s+/g, "-")}">${text}</option>`)
    .join("");
  document.body.innerHTML = `
    <div class="bb-custom-select-container bb-customSelect">
      <span class="bb-custom-select-opener"
            role="combobox" aria-autocomplete="list" aria-expanded="false"
            aria-owns="panel-${fieldId}"
            aria-activedescendant=""
            tabindex="0"><span></span></span>
      <select id="rcf${fieldId}" name="rcf${fieldId}"
              class="iCIMS_Forms_RequiredField form-control dropdown-hide" aria-required="true">
        <option value="">Select</option>
        ${optionsHtml}
      </select>
    </div>
    <ul id="panel-${fieldId}" role="listbox"></ul>
  `;
  const openerEl = document.querySelector(".bb-custom-select-opener") as unknown as HappyDomElement;
  const hiddenSelect = document.getElementById(`rcf${fieldId}`) as unknown as { value: string };
  const panelEl = document.getElementById(`panel-${fieldId}`) as unknown as HappyDomElement;
  // happy-dom implements no layout engine, so `offsetParent` never reflects
  // `dropdown-hide`'s CSS — stand it in for the browser's real `display:none`
  // null, the same idiom bugfix-002's own test and the acceptance test use, so
  // OPENER_PAIRED_HIDDEN_SELECT_EL_EXPR's `offsetParent === null` gate sees
  // this select as hidden the way a real browser would.
  Object.defineProperty(hiddenSelect, "offsetParent", { value: null, configurable: true });

  let openerClickCount = 0;
  let openerClickWasTrustedMouseEvent = false;
  let optionClickCount = 0;

  // Genuine, GENUINELY-ATTACHED listener standing in for Base Web's own open
  // handler — the only way this fires is a real dispatched click, never a
  // DOM mutation that bypasses event dispatch.
  (
    openerEl as unknown as {
      addEventListener: (type: string, cb: (ev: unknown) => void) => void;
    }
  ).addEventListener("click", (ev) => {
    openerClickCount += 1;
    openerClickWasTrustedMouseEvent = ev instanceof window.MouseEvent;
    const expanded = openerEl.getAttribute("aria-expanded") === "true";
    if (expanded) {
      openerEl.setAttribute("aria-expanded", "false");
      panelEl.innerHTML = "";
      return;
    }
    // Real Base Web timing: the panel renders no option nodes until AFTER
    // aria-expanded is flipped true — a resolver that probes for options
    // synchronously on click, before this attribute is set, would race and
    // find nothing.
    openerEl.setAttribute("aria-expanded", "true");
    panelEl.innerHTML = options
      .map((text, i) => `<li role="option" id="opt-${fieldId}-${i}">${text}</li>`)
      .join("");
    for (const optEl of Array.from(panelEl.children) as HappyDomElement[]) {
      (
        optEl as unknown as {
          addEventListener: (type: string, cb: (ev: unknown) => void) => void;
        }
      ).addEventListener("click", () => {
        optionClickCount += 1;
        openerEl.setAttribute("aria-activedescendant", optEl.id);
        // Real Base Web collapses the panel visually but does not detach the
        // committed option node — leave it in place so the committed
        // aria-activedescendant target remains a real child of the panel,
        // provable after the fact.
        openerEl.setAttribute("aria-expanded", "false");
      });
    }
  });

  return {
    window,
    openerEl,
    hiddenSelect,
    panelEl,
    openerClickCount: () => openerClickCount,
    openerClickWasTrustedMouseEvent: () => openerClickWasTrustedMouseEvent,
    optionClickCount: () => optionClickCount,
  };
}

/** Wires the real generated expression strings against a live happy-dom document. */
function makeTarget(window: Window): FrameTarget {
  const document = window.document;

  const evaluate = (async (expr: unknown): Promise<unknown> => {
    const src = String(expr);
    const fn = new window.Function("document", `return (${src});`) as (d: unknown) => unknown;
    return fn(document);
  }) as FrameTarget["evaluate"];

  const locator = ((selector: string) => {
    const query = (): HappyDomElement[] =>
      Array.from(document.querySelectorAll(selector)) as unknown as HappyDomElement[];
    return {
      first: () => ({
        click: async () => {
          const el = query()[0];
          if (!el) throw new Error(`no element for locator "${selector}"`);
          // A genuinely dispatched MouseEvent — the same delivery mechanism
          // a real Playwright `.click()` uses — so listeners that check
          // `ev instanceof MouseEvent` (rejecting a bare synthetic `Event`)
          // receive a real activation.
          (el as unknown as { dispatchEvent: (ev: unknown) => void }).dispatchEvent(
            new window.MouseEvent("click", { bubbles: true })
          );
        },
        fill: async (value: string) => {
          const el = query()[0] as unknown as { value: string } | undefined;
          if (!el) throw new Error(`no element for locator "${selector}"`);
          el.value = value;
        },
      }),
      count: async () => query().length,
    };
  }) as unknown as FrameTarget["locator"];

  guardedObserve.mockResolvedValue([]);
  guardedAct.mockResolvedValue({
    success: false,
    message: "no candidate",
    actionDescription: "",
    actions: [],
  });

  return {
    frame: null,
    frameSelector: null,
    evaluate,
    locator,
    url: () => Promise.resolve("https://careers.example.com/apply/job/1"),
    title: () => Promise.resolve("Apply"),
  };
}

function baseParams(
  page: Page,
  target: FrameTarget,
  step: string
): Parameters<typeof executeStepWithHealing>[0] {
  return {
    stagehand: makeStagehand(),
    page,
    step,
    optional: false,
    upload: false,
    submitStep: false,
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
    frameTarget: target,
  } as never;
}

describe("flow-runner/executeStepWithHealing — opener+hidden-select composite actuation sequence", () => {
  it("trusted-clicks the opener, waits for aria-expanded=true before probing, then clicks the matching option in the aria-owns panel", async () => {
    const {
      window,
      openerEl,
      hiddenSelect,
      panelEl,
      openerClickCount,
      openerClickWasTrustedMouseEvent,
      optionClickCount,
    } = buildOpenerHiddenSelectWidget({
      fieldId: "state",
      options: ["Alabama", "Alaska", "Georgia"],
    });
    const target = makeTarget(window);
    const page = fakePage();

    // There are no <option> elements anywhere under the visible opener node
    // in this widget shape — assert that up front, so a click landing there
    // would be observably impossible, matching the report's "there are none"
    // framing rather than merely asserting where the click DID land.
    expect(openerEl.querySelectorAll("option").length).toBe(0);

    const outcome = await executeStepWithHealing(
      baseParams(page, target, "Select 'Georgia' from the dropdown")
    );

    expect(outcome).toBe("completed");

    // (1) The opener received a real dispatched click a genuinely attached
    // listener observed as a trusted-shaped MouseEvent, not a synthetic
    // mutation bypassing dispatch.
    expect(openerClickCount()).toBe(1);
    expect(openerClickWasTrustedMouseEvent()).toBe(true);

    // (2) The panel only exposed its option nodes after aria-expanded was
    // flipped true by the opener's own handler — the resolver's option-click
    // could only have succeeded by waiting for that state before probing,
    // since the fixture withholds the option nodes until then.
    expect(optionClickCount()).toBe(1);

    // (3) The click landed on the option INSIDE the aria-owns panel matching
    // the target text — the opener's own committed-value pointer resolves to
    // the panel's "Georgia" node.
    const committedId = openerEl.getAttribute("aria-activedescendant");
    expect(committedId).toBeTruthy();
    const committedEl = window.document.getElementById(committedId ?? "");
    expect(panelEl.contains(committedEl as unknown as HappyDomElement)).toBe(true);
    expect(committedEl?.textContent).toBe("Georgia");

    // Never wrote the hidden select directly — the actuation target was the
    // opener/panel, not the shadow control.
    expect(hiddenSelect.value).toBe("");
  });
});
