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

  it("pairs a flat layered field whose opener is labelled by the select's label", async () => {
    const h = buildPromptWidgetHarness({
      html: `<form><div class="field"><label id="a-l" for="a-sel">Country</label>
<span id="a-op" role="combobox" aria-expanded="false" aria-owns="a-pnl" aria-labelledby="a-l" tabindex="0" style="width:0px;height:0px"><span></span></span>
<select id="a-sel" role="combobox" tabindex="-1" aria-label="Country" style="${COVERED}"><option value=""></option></select>
<div id="a-pnl" role="listbox"></div>
<a id="a-vis" role="combobox" aria-expanded="false" aria-label="— Make a Selection —">— Make a Selection —</a></div></form>`,
      popupByWidgetId: { "a-vis": { options: ["France", "Norway"] } },
    });
    const r = await executeStepWithHealing(
      params(h.page as unknown as Page, "Select 'Norway' in the 'Country' dropdown") as never
    );
    expect(r).toBe("completed");
    expect(h.window.document.querySelector("#a-vis")?.textContent).toContain("Norway");
  });

  it("pairs fields whose openers carry no label, through the wrapper each shares with its select", async () => {
    // The select's placeholder option gives the opener's wrapper text of its
    // own, so the anchor does not share the opener's ancestor-text label: only
    // the wrapper ties the opener to the select.
    const field = (
      p: string,
      label: string
    ) => `<div class="field"><label id="${p}-l" for="${p}-sel">${label}</label>
<div class="control"><span id="${p}-op" role="combobox" aria-expanded="false" aria-owns="${p}-pnl" tabindex="0" style="width:0px;height:0px"><span></span></span>
<select id="${p}-sel" role="combobox" tabindex="-1" aria-label="${label}" style="${COVERED}"><option value="">--</option></select>
<div id="${p}-pnl" role="listbox"></div></div>
<a id="${p}-vis" role="combobox" aria-expanded="false" aria-label="— Make a Selection —">— Make a Selection —</a></div>`;
    const h = buildPromptWidgetHarness({
      html: `<form><div class="row">${field("a", "Country")}${field("b", "Region")}</div></form>`,
      popupByWidgetId: {
        "a-vis": { options: ["France", "Norway"] },
        "b-vis": { options: ["North", "Norway"] },
      },
    });
    const doc = h.window.document;
    const r = await executeStepWithHealing(
      params(h.page as unknown as Page, "Select 'Norway' in the 'Country' dropdown") as never
    );
    expect(r).toBe("completed");
    expect(doc.querySelector("#a-vis")?.textContent).toContain("Norway");
    expect(doc.querySelector("#b-vis")?.textContent).toContain("Make a Selection");
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

  it("a hidden duplicate of the neighbouring widget does not make the select layered", async () => {
    const { result, doc } = await run(
      `<form><fieldset><legend>Date of birth</legend><div class="row">
<label for="m">Month</label><select id="m"><option value="">--</option><option>January</option></select>
<div id="yr" role="combobox" aria-haspopup="listbox" tabindex="0">— Make a Selection —</div>
<div id="yr-m" role="combobox" aria-haspopup="listbox" tabindex="0" style="display:none">— Make a Selection —</div></div></fieldset></form>`,
      { yr: { options: ["1989", "1990"] } },
      "Select '1990' in the 'Date of birth' dropdown"
    );
    expect(result).toBe("completed");
    expect(doc.querySelector("#yr")?.textContent).toContain("1990");
  });

  it("another widget's shadow opener in the same row does not pair the plain select", async () => {
    const { result, doc } = await run(
      `<form><div class="field"><label for="c">Country</label>
<select id="c"><option value="">--</option><option>Other (not listed)</option></select>
<div class="control"><span id="op" role="combobox" aria-expanded="false" aria-owns="pnl" aria-label="Currency" tabindex="0" style="width:0px;height:0px"><span></span></span>
<select id="csel" role="combobox" tabindex="-1" aria-label="Currency" style="position:absolute;opacity:0;width:1px;height:1px"><option value=""></option></select>
<div id="pnl" role="listbox"></div></div>
<a id="vis" role="combobox" aria-expanded="false" aria-label="— Make a Selection —">— Make a Selection —</a></div></form>`,
      { vis: { options: ["Other", "USD"] } },
      "Select 'Other' in the 'Country' dropdown"
    );
    expect(result).not.toBe("completed");
    expect(doc.querySelector("#vis")?.textContent).toContain("Make a Selection");
  });

  // A plain select beside a neighbour, with an unrelated member that shares a
  // wrapper or a label with the select (a control group, a hidden hint, a
  // hidden picker, a hidden duplicate). None of these is the select's shadow
  // opener, so the step for the select never writes into the neighbour.
  const CUR = `<div id="cur" role="combobox" aria-haspopup="listbox" tabindex="0">— Make a Selection —</div>`;
  const COUNTRY = `<select id="c"><option value="">--</option><option>Other (not listed)</option></select>`;

  it.each([
    [
      "a control group holding the select, the widget and a hidden menu button",
      `<form><fieldset><legend>Preferred currency</legend><div class="field"><label for="c">Country</label>
<div class="inputs">${COUNTRY}
${CUR}<button id="more" type="button" aria-haspopup="listbox" aria-hidden="true" tabindex="-1">...</button></div></div></fieldset></form>`,
    ],
    [
      "a control group holding the select, the widget and a display:none menu button",
      `<form><div class="field"><label for="c">Country</label><div class="inputs">
${COUNTRY}
${CUR}
<button id="more" type="button" aria-haspopup="listbox" style="display:none">more</button></div></div></form>`,
    ],
    [
      "a hidden hint with a popup link in the select's own wrapper",
      `<form><fieldset><legend>Preferred currency</legend><div class="field"><label for="c">Country</label>
<div class="select-wrap">${COUNTRY}<div class="err" aria-haspopup="listbox" style="display:none">Please choose</div></div>
${CUR}</div></fieldset></form>`,
    ],
    [
      "a hidden custom picker labelled as the select",
      `<form><fieldset><legend>Preferred currency</legend><div class="field"><label for="c">Country</label>
${COUNTRY}
<div id="cm" role="combobox" aria-haspopup="listbox" tabindex="0" aria-label="Country" style="display:none">— Make a Selection —</div>
${CUR}</div></fieldset></form>`,
    ],
    [
      "a plain anchor neighbour in a control group with its hidden duplicate",
      `<form><fieldset><legend>Preferred currency</legend><div class="field"><label for="c">Country</label>
<div class="inputs">${COUNTRY}
<a id="cur" role="combobox" aria-expanded="false">— Make a Selection —</a><div id="curm" role="combobox" aria-haspopup="listbox" tabindex="0" style="display:none">— Make a Selection —</div></div></div></fieldset></form>`,
    ],
  ])("a plain select is not paired with its neighbour: %s", async (_name, html) => {
    const { result, doc } = await run(
      html,
      { cur: { options: ["Other", "USD"] } },
      "Select 'Other' in the 'Country' dropdown"
    );
    expect(result).not.toBe("completed");
    expect(doc.querySelector("#cur")?.textContent).toContain("Make a Selection");
    expect((doc.querySelector("#c") as unknown as { value: string }).value).toBe("");
  });
});

describe("prompt-selector: zero-area openers where the page has layout", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // happy-dom lays nothing out (every box is 0x0), so the geometry branch only
  // runs when the field and the visible trigger are given a box.
  function giveBox(doc: { querySelector: (s: string) => unknown }, selectors: string[]) {
    for (const sel of selectors) {
      const el = doc.querySelector(sel) as object;
      Object.defineProperty(el, "getBoundingClientRect", {
        value: () => ({
          x: 10,
          y: 10,
          left: 10,
          top: 10,
          right: 210,
          bottom: 40,
          width: 200,
          height: 30,
          toJSON: () => ({}),
        }),
      });
    }
  }

  async function run(
    html: string,
    boxed: string[],
    popups: Record<string, { options: string[] }>,
    step: string
  ) {
    const h = buildPromptWidgetHarness({ html, popupByWidgetId: popups });
    giveBox(h.window.document, boxed);
    let result: unknown;
    try {
      result = await executeStepWithHealing(params(h.page as unknown as Page, step) as never);
    } catch (err) {
      result = err;
    }
    return { result, doc: h.window.document };
  }

  it("pairs a rendered zero-area opener that owns a popup", async () => {
    const { result, doc } = await run(
      `<form><div class="field"><label id="a-l" for="a-sel">Country</label>
<div class="control"><span id="a-op" role="combobox" aria-expanded="false" aria-owns="a-pnl" tabindex="0"></span>
<select id="a-sel" role="combobox" tabindex="-1" aria-label="Country" style="${COVERED}"><option value=""></option></select>
<div id="a-pnl" role="listbox"></div></div>
<a id="a-vis" role="combobox" aria-expanded="false" aria-label="— Make a Selection —">— Make a Selection —</a></div></form>`,
      [".field", "#a-vis"],
      { "a-vis": { options: ["France", "Norway"] } },
      "Select 'Norway' in the 'Country' dropdown"
    );
    expect(result).toBe("completed");
    expect(doc.querySelector("#a-vis")?.textContent).toContain("Norway");
  });

  it("an empty zero-area chevron with no popup link does not pair the select with a plain anchor", async () => {
    const { result, doc } = await run(
      `<form><fieldset><legend>Preferred currency</legend><div class="field"><label for="c">Country</label>
<div class="select-wrap"><select id="c"><option value="">--</option><option>Other (not listed)</option></select><span class="chev" role="combobox" aria-haspopup="listbox"></span></div>
<a id="cur" role="combobox" aria-expanded="false">— Make a Selection —</a></div></fieldset></form>`,
      [".field", "#cur", "#c"],
      { cur: { options: ["Other", "USD"] } },
      "Select 'Other' in the 'Country' dropdown"
    );
    expect(result).not.toBe("completed");
    expect(doc.querySelector("#cur")?.textContent).toContain("Make a Selection");
    expect((doc.querySelector("#c") as unknown as { value: string }).value).toBe("");
  });
});

describe("prompt-selector: layered pairing for a select in the trigger union is unchanged", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("pairs a union select with its visible trigger even with no shadow opener", async () => {
    const h = buildPromptWidgetHarness({
      html: `<form><div class="field"><label id="a-l" for="a-sel">Country</label>
<div class="control"><select id="a-sel" role="combobox" aria-controls="a-sel-lb" tabindex="-1" aria-label="Country" style="${COVERED}"><option value=""></option></select></div>
<a id="a-vis" role="combobox" aria-expanded="false" aria-label="— Make a Selection —">— Make a Selection —</a></div></form>`,
      popupByWidgetId: { "a-vis": { options: ["France", "Norway"] } },
    });
    const r = await executeStepWithHealing(
      params(h.page as unknown as Page, "Select 'Norway' in the 'Country' dropdown") as never
    );
    expect(r).toBe("completed");
    expect(h.window.document.querySelector("#a-vis")?.textContent).toContain("Norway");
  });
});
