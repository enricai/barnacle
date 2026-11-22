import type { Page, Stagehand } from "@browserbasehq/stagehand";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { executeStepWithHealing } from "@/scraper/flow-runner";
import { buildPromptWidgetHarness } from "@/scraper/prompt-widget-dom-harness.test-helper";
import type { Logger } from "@/types/logging";

vi.mock("@/lib/llm/judges/select-option", () => ({
  judgeSelectOptionWithLLM: vi.fn(),
}));

/**
 * A search-on-submit typeahead whose filter input sits inside a <form> with a
 * default submit button. The trusted Enter must still be dispatched, but the
 * browser's implicit form submission must be cancelled and the temporary
 * listeners removed afterwards.
 */

const testLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

const WIDGET = `
<div id="degree-widget" data-uxi-widget-type="multiselect" data-automation-id="multiSelectContainer">
  <div data-automation-id="multiselectInputContainer">
    <input id="degree-input" data-uxi-widget-type="selectinput" type="text" class="dropdown-search" role="combobox"
           aria-autocomplete="list" placeholder="Search" value="" />
  </div>
  <div data-automation-id="promptSelectionLabel"></div>
</div>`;

const FORM_HTML = `
<form id="profile-form" action="https://example.com/submit">
  <label for="degree-input"><span>Degree</span></label>
  ${WIDGET}
  <button type="submit">Save</button>
</form>`;

const NO_FORM_HTML = `<div>
  <label for="degree-input"><span>Degree</span></label>
  ${WIDGET}
</div>`;

const OPTIONS = ["Associate&#039;s Degree", "Bachelor of Arts", "Doctorate"];

function baseParams(page: Page, step: string) {
  const stagehand = {
    act: vi.fn(),
    observe: vi.fn().mockResolvedValue([]),
  } as unknown as Stagehand;
  return {
    stagehand,
    page,
    step,
    optional: false,
    upload: false,
    submitStep: false,
    stepIndex: 3,
    phase: "apply",
    signalCounter: { n: 0 },
    recentCaptures: [],
    recentCaptureMeta: [],
    anthropic: null,
    rephraseModel: null,
    logger: testLogger,
    captureFn: vi.fn().mockResolvedValue(undefined),
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

function enterKeyDowns(cdpEvents: { method: string; params: unknown }[]): number {
  return cdpEvents.filter((e) => {
    const p = e.params as { type?: string; key?: string } | undefined;
    return e.method === "Input.dispatchKeyEvent" && p?.type === "keyDown" && p.key === "Enter";
  }).length;
}

async function run(html: string) {
  const harness = buildPromptWidgetHarness({
    html,
    popupByWidgetId: {
      "degree-widget": { options: OPTIONS, searchOnSubmit: true },
    },
  });
  const { window, page } = harness;
  const doc = window.document;
  const input = doc.getElementById("degree-input") as unknown as {
    dispatchEvent(e: unknown): boolean;
    closest(s: string): { dispatchEvent(e: unknown): boolean } | null;
  };

  const keydowns: { defaultPrevented: boolean }[] = [];
  let submits = 0;
  doc.addEventListener("submit", ((e: { preventDefault(): void }) => {
    e.preventDefault();
    submits += 1;
  }) as never);

  // Emulate the browser: a trusted Enter keydown reaches the focused input and,
  // unless its default is prevented, triggers implicit submission of the form.
  const sendCDP = (page as { sendCDP: (m: string, p?: unknown) => Promise<void> }).sendCDP.bind(
    page
  );
  (page as { sendCDP: unknown }).sendCDP = async (method: string, params?: unknown) => {
    const p = params as { type?: string; key?: string } | undefined;
    if (method === "Input.dispatchKeyEvent" && p?.type === "keyDown" && p.key === "Enter") {
      const ev = new window.KeyboardEvent("keydown", {
        key: "Enter",
        bubbles: true,
        cancelable: true,
      });
      input.dispatchEvent(ev);
      keydowns.push({ defaultPrevented: ev.defaultPrevented });
      const form = input.closest("form");
      if (!ev.defaultPrevented && form) {
        form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
      }
    }
    return sendCDP(method, params);
  };

  const result = await executeStepWithHealing({
    ...baseParams(page as unknown as Page, ""),
    frameTarget: harness.target,
    step: "for 'Degree' select 'Doctorate'",
  } as unknown as Parameters<typeof executeStepWithHealing>[0]);

  // Probe whether guard listeners linger: a fresh Enter keydown must be unprevented.
  const probe = new window.KeyboardEvent("keydown", {
    key: "Enter",
    bubbles: true,
    cancelable: true,
  });
  input.dispatchEvent(probe as unknown as Event);

  return {
    result,
    harness,
    keydowns,
    submits: () => submits,
    leftoverPrevented: probe.defaultPrevented,
  };
}

describe("flow-runner/tryPromptSelectorPrimitive search Enter inside a form", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("dispatches the trusted Enter but cancels implicit form submission and cleans up", async () => {
    const { result, harness, keydowns, submits, leftoverPrevented } = await run(FORM_HTML);

    expect(result).toBe("completed");
    expect(enterKeyDowns(harness.cdpEvents)).toBe(1);
    expect(keydowns).toEqual([{ defaultPrevented: true }]);
    expect(submits()).toBe(0);
    expect(leftoverPrevented).toBe(false);
    expect(
      (harness.window as unknown as { __leerieNoImplicitSubmit?: unknown }).__leerieNoImplicitSubmit
    ).toBeUndefined();
  });

  it("still dispatches Enter without a form", async () => {
    const { result, harness, keydowns, submits } = await run(NO_FORM_HTML);

    expect(result).toBe("completed");
    expect(enterKeyDowns(harness.cdpEvents)).toBe(1);
    expect(keydowns).toHaveLength(1);
    expect(submits()).toBe(0);
  });
});
