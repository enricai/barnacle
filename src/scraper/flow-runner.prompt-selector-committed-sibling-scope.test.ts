import type { Page, Stagehand } from "@browserbasehq/stagehand";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { executeStepWithHealing } from "@/scraper/flow-runner";
import { buildPromptWidgetHarness } from "@/scraper/prompt-widget-dom-harness.test-helper";
import type { Logger } from "@/types/logging";

const SEARCH_MARK = "data-bcl-prompt-opt-idx-search";
const OPTION_MARK = "data-bcl-prompt-opt-idx";

const testLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

const committedWidget = (id: string, label: string, value: string): string => `
  <div>
    <label for="${id}--input">${label}</label>
    <div id="${id}" data-uxi-widget-type="multiselect" data-automation-id="multiSelectContainer">
      <div data-automation-id="promptSelectionLabel">${value}</div>
      <div data-automation-id="selectedItem" role="option" id="chip-${id}">${value}</div>
      <input id="${id}--input" data-uxi-widget-type="selectinput" type="text" value="" />
    </div>
  </div>`;

const targetWidget = `
  <div>
    <label for="b--input">Arrival city</label>
    <div id="b" data-uxi-widget-type="multiselect" data-automation-id="multiSelectContainer">
      <input id="b--input" data-uxi-widget-type="selectinput" type="text" value="" />
    </div>
  </div>`;

const LAYOUTS: Record<string, string> = {
  "committed sibling before": `<form>${committedWidget("a", "Departure city", "Lisbon")}${targetWidget}</form>`,
  "committed sibling after": `<form>${targetWidget}${committedWidget("a", "Departure city", "Lisbon")}</form>`,
  "two committed siblings before": `<form>${committedWidget("a", "Departure city", "Lisbon")}${committedWidget("c", "Stopover", "Madrid")}${targetWidget}</form>`,
};
type Popup = Parameters<typeof buildPromptWidgetHarness>[0]["popupByWidgetId"][string];

async function runStep(
  html: string,
  popup: Popup,
  step = "for 'Arrival city' select 'Porto'"
): Promise<{
  window: ReturnType<typeof buildPromptWidgetHarness>["window"];
  fills: { selector: string; value: string }[];
  clicks: string[];
  trajectory: { targetId?: string }[];
}> {
  const stagehand = {
    act: vi.fn(),
    observe: vi.fn().mockResolvedValue([]),
  } as unknown as Stagehand;
  const { page, target, window, fills, clicks } = buildPromptWidgetHarness({
    html,
    popupByWidgetId: { b: popup },
  });
  const trajectory: { targetId?: string }[] = [];
  await executeStepWithHealing({
    stagehand,
    page: page as unknown as Page,
    frameTarget: target,
    step,
    optional: false,
    upload: false,
    submitStep: false,
    stepIndex: 1,
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
    trajectory,
  } as never);
  return { window, fills, clicks, trajectory };
}

describe("flow-runner/tryPromptSelectorPrimitive committed-sibling isolation under unresolved scope", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const POPUPS: [string, Popup][] = [
    ["unlinked portal", { options: ["Porto"], portaled: true, unlinkedPortal: true }],
    [
      "unlinked searchable portal",
      { options: ["Porto"], portaled: true, unlinkedPortal: true, searchable: true },
    ],
    [
      "late aria-controls, searchable",
      {
        options: ["Porto"],
        portaled: true,
        searchable: true,
        linkAfterOpen: true,
        linkDelayMs: 300,
      },
    ],
  ];

  describe.each(Object.entries(LAYOUTS))("%s", (_layout, html) => {
    it.each(POPUPS)("%s: never types into or reads from a committed sibling", async (_n, popup) => {
      const { window, fills, clicks, trajectory } = await runStep(html, popup);
      const doc = window.document;
      for (const id of ["a", "c"]) {
        expect(doc.getElementById(`${id}--input`)?.hasAttribute(SEARCH_MARK)).not.toBe(true);
        expect(doc.getElementById(`chip-${id}`)?.hasAttribute(OPTION_MARK)).not.toBe(true);
        expect(fills.every((f) => !f.selector.includes(`${id}--input`))).toBe(true);
        expect(clicks.some((c) => c.includes(`chip-${id}`))).toBe(false);
      }
      for (const t of trajectory) expect(t.targetId).not.toBe("a");
    });
  });

  it("still reads an unlinked portal's options when no other widget has content", async () => {
    const { trajectory } = await runStep(`<form>${targetWidget}</form>`, {
      options: ["Porto"],
      portaled: true,
      unlinkedPortal: true,
    });
    expect(trajectory.at(-1)?.targetId).toBe("b");
  });

  it("button target with a late aria-controls popup waits for it beside a committed sibling", async () => {
    const buttonTarget = `
      <div>
        <label for="b">Degree</label>
        <button id="b" type="button" aria-haspopup="listbox" aria-invalid="true"><span>Select One</span></button>
      </div>`;
    const { window, trajectory } = await runStep(
      `<form>${committedWidget("a", "Departure city", "Lisbon")}${buttonTarget}</form>`,
      { options: ["Porto"], portaled: true, linkAfterOpen: true, linkDelayMs: 300 },
      "for 'Degree' select 'Porto'"
    );
    expect(window.document.getElementById("chip-a")?.hasAttribute(OPTION_MARK)).not.toBe(true);
    expect(trajectory.at(-1)?.targetId).toBe("b");
  });

  describe("sibling markup the widget-kit container resolution does not recognize", () => {
    const bareSibling = `
      <div>
        <label>Departure city</label>
        <div id="a">
          <div data-automation-id="promptSelectionLabel">Lisbon</div>
          <ul><li data-automation-id="promptOption" role="option" id="chip-a">Lisbon</li></ul>
          <input id="a--input" role="searchbox" type="text" value="" />
        </div>
      </div>`;
    const comboSibling = `
      <div>
        <label>Departure city</label>
        <div id="a">
          <input id="a--input" role="combobox" aria-haspopup="listbox" type="text" value="Lisbon" />
          <ul><li role="option" id="chip-a">Lisbon</li></ul>
        </div>
      </div>`;
    const comboTarget = `
      <div>
        <label for="b">Arrival city</label>
        <input id="b" role="combobox" aria-haspopup="listbox" type="text" value="" />
      </div>`;

    it.each([
      ["bare sibling before", `<form>${bareSibling}${targetWidget}</form>`],
      ["bare sibling after", `<form>${targetWidget}${bareSibling}</form>`],
      ["combobox sibling before", `<form>${comboSibling}${targetWidget}</form>`],
    ])("%s: unlinked searchable portal never touches the sibling", async (_n, html) => {
      const { window, fills, clicks } = await runStep(html, {
        options: ["Porto"],
        portaled: true,
        unlinkedPortal: true,
        searchable: true,
      });
      const doc = window.document;
      expect(doc.getElementById("a--input")?.hasAttribute(SEARCH_MARK)).not.toBe(true);
      expect(doc.getElementById("chip-a")?.hasAttribute(OPTION_MARK)).not.toBe(true);
      expect(fills.every((f) => !f.selector.includes("a--input"))).toBe(true);
      expect(clicks.some((c) => c.includes("chip-a"))).toBe(false);
    });

    it("an input-shaped target types into itself, not the committed sibling's input", async () => {
      const { window, fills } = await runStep(`<form>${comboSibling}${comboTarget}</form>`, {
        options: ["Porto"],
        portaled: true,
        unlinkedPortal: true,
        searchable: true,
      });
      expect(window.document.getElementById("a--input")?.hasAttribute(SEARCH_MARK)).not.toBe(true);
      expect(fills.every((f) => !f.selector.includes("a--input"))).toBe(true);
    });
  });
});
