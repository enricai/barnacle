import type { Page, Stagehand } from "@browserbasehq/stagehand";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { executeStepWithHealing } from "@/scraper/flow-runner";
import { buildPromptWidgetHarness } from "@/scraper/prompt-widget-dom-harness.test-helper";
import type { Logger } from "@/types/logging";

vi.mock("@/lib/llm/judges/select-option", () => ({
  judgeSelectOptionWithLLM: vi.fn(),
}));

/**
 * Layered dropdown field whose covered native `<select>` carries the field's
 * label but no popup link of its own (no `aria-controls`/`aria-owns`). The
 * field also holds a 0x0 shadow opener (`aria-owns` → an empty listbox shell)
 * and one visible rendered trigger. The select's own options never hold the
 * answer, so the prompt-selector primitive must still anchor the layered
 * pairing on it, whether or not the select carries a popup link and however
 * it is covered: one candidate per field, clicked at the visible trigger,
 * options read from the list that trigger opens.
 */

const testLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

function params(page: Page, step: string) {
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
    trajectory: [],
  };
}

const COVERED = "position:absolute;opacity:0;width:1px;height:1px";

/** One layered field. `selectExtra` adds attributes to the covered select. */
function layeredField(p: string, label: string, selectExtra = "", selectStyle = ""): string {
  return `
<div class="field">
  <label id="${p}-l" for="${p}-sel">${label}</label>
  <div class="control">
    <span id="${p}-op" role="combobox" aria-expanded="false" aria-owns="${p}-pnl" aria-labelledby="${p}-l" tabindex="0" style="width:0px;height:0px"><span></span></span>
    <select id="${p}-sel" role="combobox" tabindex="-1" aria-label="${label}"${selectExtra}${selectStyle ? ` style="${selectStyle}"` : ""}><option value=""></option></select>
    <div id="${p}-pnl" role="listbox"></div>
  </div>
  <a id="${p}-vis" role="combobox" aria-expanded="false" aria-label="— Make a Selection —">— Make a Selection —</a>
</div>`;
}

describe("prompt-selector: layered field anchored on a select with no popup link", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    ["unstyled select", ""],
    ["covered select", COVERED],
  ])("drives the visible trigger and picks from its list (%s)", async (_name, style) => {
    const h = buildPromptWidgetHarness({
      html: `<form>${layeredField("a", "Country", "", style)}</form>`,
      popupByWidgetId: { "a-vis": { options: ["France", "Norway"] } },
    });
    const r = await executeStepWithHealing(
      params(h.page as unknown as Page, "Select 'Norway' in the 'Country' dropdown") as never
    );
    expect(r).toBe("completed");
    expect(testLogger.info).toHaveBeenCalledWith(
      expect.stringContaining("resolved by prompt-selector primitive")
    );
    expect(h.window.document.querySelector("#a-vis")?.textContent).toContain("Norway");
  });

  it("still passes when the select does carry aria-controls", async () => {
    const h = buildPromptWidgetHarness({
      html: `<form>${layeredField("a", "Country", ' aria-controls="a-sel-listbox"', COVERED)}</form>`,
      popupByWidgetId: { "a-vis": { options: ["France", "Norway"] } },
    });
    const r = await executeStepWithHealing(
      params(h.page as unknown as Page, "Select 'Norway' in the 'Country' dropdown") as never
    );
    expect(r).toBe("completed");
    expect(h.window.document.querySelector("#a-vis")?.textContent).toContain("Norway");
  });

  it("never merges two fields: each step drives only its own field's trigger and list", async () => {
    const h = buildPromptWidgetHarness({
      html: `<form><div class="row">${layeredField("a", "Country", "", COVERED)}${layeredField("b", "Region", "", COVERED)}</div></form>`,
      popupByWidgetId: {
        "a-vis": { options: ["France", "Norway"] },
        "b-vis": { options: ["North", "South"] },
      },
    });
    const doc = h.window.document;
    const r1 = await executeStepWithHealing(
      params(h.page as unknown as Page, "Select 'South' in the 'Region' dropdown") as never
    );
    expect(r1).toBe("completed");
    expect(doc.querySelector("#b-vis")?.textContent).toContain("South");
    expect(doc.querySelector("#a-vis")?.textContent).toContain("Make a Selection");

    const r2 = await executeStepWithHealing(
      params(h.page as unknown as Page, "Select 'Norway' in the 'Country' dropdown") as never
    );
    expect(r2).toBe("completed");
    expect(doc.querySelector("#a-vis")?.textContent).toContain("Norway");
    expect(doc.querySelector("#b-vis")?.textContent).toContain("South");
    // The shadow openers' empty shells never received an option.
    expect(doc.querySelector("#a-pnl")?.children.length).toBe(0);
    expect(doc.querySelector("#b-pnl")?.children.length).toBe(0);
  });

  it("a hidden select with no visible sibling trigger is not collapsed onto anything", async () => {
    // The shadow opener is the only other control; it is unrendered, so the
    // field has no visible trigger to collapse onto and the step fails as it
    // did before (no option list ever renders).
    const html = `
<form>
  <div class="field">
    <label id="a-l" for="a-sel">Country</label>
    <div class="control">
      <span id="a-op" role="combobox" aria-expanded="false" aria-owns="a-pnl" aria-labelledby="a-l" tabindex="0" style="width:0px;height:0px"><span></span></span>
      <select id="a-sel" role="combobox" tabindex="-1" aria-label="Country" style="${COVERED}"><option value=""></option></select>
      <div id="a-pnl" role="listbox"></div>
    </div>
  </div>
  <div class="field">
    <label for="b-in">Notes</label>
    <a id="b-vis" role="combobox" aria-expanded="false" aria-label="— Make a Selection —">— Make a Selection —</a>
  </div>
</form>`;
    const h = buildPromptWidgetHarness({
      html,
      popupByWidgetId: { "b-vis": { options: ["France", "Norway"] } },
    });
    await expect(
      executeStepWithHealing(
        params(h.page as unknown as Page, "Select 'Norway' in the 'Country' dropdown") as never
      )
    ).rejects.toThrow();
    // The other field's visible trigger is never adopted for this field (had
    // it been clicked, its list would have rendered and the step completed).
    expect(h.window.document.querySelector("#b-vis")?.textContent).toContain("Make a Selection");
  });
});

describe("prompt-selector: a visible working select is never paired with a neighbouring widget", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  async function run(html: string, popups: Record<string, { options: string[] }>, step: string) {
    const h = buildPromptWidgetHarness({ html, popupByWidgetId: popups });
    let result: unknown;
    try {
      result = await executeStepWithHealing(params(h.page as unknown as Page, step) as never);
    } catch (err) {
      result = err;
    }
    return { result, doc: h.window.document };
  }

  it("a year widget beside a Month select keeps its own label", async () => {
    const { result, doc } = await run(
      `<form><fieldset><legend>Date of birth</legend><div class="row">
<label for="m">Month</label><select id="m"><option value="">--</option><option>January</option></select>
<div id="yr" role="combobox" aria-haspopup="listbox" tabindex="0">— Make a Selection —</div></div></fieldset></form>`,
      { yr: { options: ["1989", "1990"] } },
      "Select '1990' in the 'Date of birth' dropdown"
    );
    expect(result).toBe("completed");
    expect(doc.querySelector("#yr")?.textContent).toContain("1990");
  });

  it("a step for the select is never written into the neighbouring widget", async () => {
    const { result, doc } = await run(
      `<form><fieldset><legend>Preferred currency</legend><div class="field"><label for="c">Country</label>
<select id="c"><option value="">--</option><option>Other (not listed)</option></select>
<div id="cur" role="combobox" aria-haspopup="listbox" tabindex="0">— Make a Selection —</div></div></fieldset></form>`,
      { cur: { options: ["Other", "USD"] } },
      "Select 'Other' in the 'Country' dropdown"
    );
    expect(result).not.toBe("completed");
    expect(doc.querySelector("#cur")?.textContent).toContain("Make a Selection");
  });

  it("a typeahead beside a labelled select adds no candidate to an unlabelled step", async () => {
    const { result, doc } = await run(
      `<form><div class="w"><div id="cat" aria-haspopup="listbox" role="combobox" tabindex="0">— Make a Selection —</div></div>
<div class="field"><label for="s">City</label><select id="s"><option value="">--</option><option>Paris</option></select>
<input id="ta" role="combobox" aria-autocomplete="list" placeholder="Search city"></div></form>`,
      { cat: { options: ["Engineering", "Sales"] } },
      "Click the top-level category 'Engineering'"
    );
    expect(result).toBe("completed");
    expect(doc.querySelector("#cat")?.textContent).toContain("Engineering");
  });
});
