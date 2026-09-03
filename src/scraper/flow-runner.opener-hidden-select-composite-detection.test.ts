import type { Page, Stagehand } from "@browserbasehq/stagehand";
import type { Element as HappyDomElement, Window } from "happy-dom";
import { Window as HappyDomWindow } from "happy-dom";
import { describe, expect, it, vi } from "vitest";

import { executeStepWithHealing } from "@/scraper/flow-runner";
import type { FrameTarget } from "@/scraper/frame-target";
import type { Logger } from "@/types/logging";

/**
 * Pins required item 1 of the Base Web `bb-customSelect` recon report: a
 * select-shaped step targeting a widget composed of a `[role="combobox"]`
 * opener paired with a sibling native `<select class="dropdown-hide">` must
 * resolve its actuation target to the OPENER, never the hidden select —
 * for all three of the report's field shapes (consent Yes/No, Country,
 * State/Province). Runs the real `executeStepWithHealing` pipeline against a
 * live happy-dom document (real `querySelectorAll`/event dispatch), asserting
 * on DOM identity/state rather than assuming which internal primitive claims
 * the step, per `flow-runner.select-from-list-committed-control.test.ts`'s
 * stated rationale.
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
 * Builds the report's exact widget shape: `.bb-custom-select-container` >
 * `span.bb-custom-select-opener[role="combobox"][aria-owns]` (the interactive
 * opener) + sibling `select.dropdown-hide` (the hidden shadow control Base
 * Web keeps in sync) + a detached `[role="listbox"]` panel the opener's
 * `aria-owns` references. The panel starts empty — options only render once
 * the opener is genuinely clicked, mirroring the real widget's "no options
 * until opened" behavior and forcing the resolver to actually drive the
 * opener rather than reading a pre-rendered popup.
 */
function buildOpenerHiddenSelectWidget(params: { fieldId: string; options: readonly string[] }): {
  window: Window;
  openerEl: HappyDomElement;
  hiddenSelect: { value: string };
  panelEl: HappyDomElement;
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

  // Genuine open gesture: renders the options into the aria-owns panel only
  // once clicked — the same "no native <select>/<input> a focused probe can
  // see until opened" shape PROMPT_TRIGGER_SELECTORS targets.
  (
    openerEl as unknown as {
      addEventListener: (type: string, cb: (ev: unknown) => void) => void;
    }
  ).addEventListener("click", () => {
    const expanded = openerEl.getAttribute("aria-expanded") === "true";
    if (expanded) {
      openerEl.setAttribute("aria-expanded", "false");
      return;
    }
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
        // Real Base Web commits the opener's own committed state
        // (aria-activedescendant) — the primitive must read/verify THIS,
        // never the hidden select, which this fixture deliberately leaves
        // untouched so any write to it is unambiguously the bug.
        openerEl.setAttribute("aria-activedescendant", optEl.id);
        openerEl.setAttribute("aria-expanded", "false");
      });
    }
  });

  return { window, openerEl, hiddenSelect, panelEl };
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

describe("flow-runner/executeStepWithHealing — opener+hidden-select composite widget resolves to the opener", () => {
  it.each([
    { name: "consent Yes/No", fieldId: "consent", options: ["Yes", "No"], want: "Yes" },
    {
      name: "Country",
      fieldId: "country",
      options: ["United States", "Canada", "Mexico"],
      want: "Canada",
    },
    {
      name: "State/Province",
      fieldId: "state",
      options: ["Alabama", "Alaska", "Georgia"],
      want: "Georgia",
    },
  ])(
    "drives the opener span, never the hidden dropdown-hide <select>, for the $name field",
    async ({ fieldId, options, want }) => {
      const { window, openerEl, hiddenSelect } = buildOpenerHiddenSelectWidget({
        fieldId,
        options,
      });
      const target = makeTarget(window);
      const page = fakePage();

      const outcome = await executeStepWithHealing(
        baseParams(page, target, `Select '${want}' from the dropdown`)
      );

      expect(outcome).toBe("completed");
      // The resolved actuation target is the opener: its own committed state
      // (aria-activedescendant) reflects the chosen option.
      const committedId = openerEl.getAttribute("aria-activedescendant");
      expect(committedId).toBeTruthy();
      const committedText = window.document.getElementById(committedId ?? "")?.textContent;
      expect(committedText).toBe(want);
      // The hidden shadow <select> — deliberately left unsynced by this
      // fixture's opener/option handlers — must never have been written to
      // directly. A non-empty value here means the resolver wrote the hidden
      // select instead of driving the opener, exactly the reported bug.
      expect(hiddenSelect.value).toBe("");
    }
  );
});
