import type { Page, Stagehand } from "@browserbasehq/stagehand";
import { describe, expect, it, vi } from "vitest";

import { executeStepWithHealing } from "@/scraper/flow-runner";
import { buildPromptWidgetHarness } from "@/scraper/prompt-widget-dom-harness.test-helper";
import type { Logger } from "@/types/logging";

const PROMPT_WIDGET_MARK_ATTR = "data-bcl-prompt-idx";

const testLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

const HTML = `
<form>
  <div id="field">
    <label id="lbl">Country</label>
    <span id="opener" role="combobox" aria-expanded="false" aria-haspopup="listbox" aria-labelledby="lbl"></span>
    <div id="combo" role="combobox" aria-expanded="false" aria-labelledby="lbl"></div>
  </div>
</form>`;

type Rect = { left: number; top: number; width: number; height: number };
const rect = (r: Rect) => ({
  ...r,
  x: r.left,
  y: r.top,
  right: r.left + r.width,
  bottom: r.top + r.height,
});

async function run(opts: {
  openerRect: Rect;
  openerStyle?: string;
  hit: "combo" | "opener";
}): Promise<{ opener: boolean; combo: boolean }> {
  const { page, target, window } = buildPromptWidgetHarness({
    html: HTML,
    popupByWidgetId: { combo: { options: ["Peru"], portaled: true } },
  });
  const doc = window.document;
  const opener = doc.getElementById("opener") as unknown as HTMLElement;
  const combo = doc.getElementById("combo") as unknown as HTMLElement;
  if (opts.openerStyle) opener.setAttribute("style", opts.openerStyle);
  const define = (el: object, name: string, value: unknown) =>
    Object.defineProperty(el, name, { value, configurable: true });
  const rects = new Map<unknown, Rect>([
    [doc.documentElement, { left: 0, top: 0, width: 1000, height: 800 }],
    [opener, opts.openerRect],
    [combo, { left: 10, top: 10, width: 200, height: 30 }],
  ]);
  for (const [el, r] of rects) {
    define(el as object, "getBoundingClientRect", () => rect(r));
    define(el as object, "getClientRects", () =>
      r.width === 0 && r.height === 0 ? [] : [rect(r)]
    );
  }
  define(window, "innerWidth", 1000);
  define(window, "innerHeight", 800);
  define(doc, "elementFromPoint", () => (opts.hit === "combo" ? combo : opener));

  await executeStepWithHealing({
    stagehand: { act: vi.fn(), observe: vi.fn().mockResolvedValue([]) } as unknown as Stagehand,
    page: page as unknown as Page,
    frameTarget: target,
    step: "for 'Country' select 'Peru'",
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
  } as never);
  return {
    opener: opener.hasAttribute(PROMPT_WIDGET_MARK_ATTR),
    combo: combo.hasAttribute(PROMPT_WIDGET_MARK_ATTR),
  };
}

const VISIBLE = { left: 10, top: 10, width: 200, height: 30 };

describe("enumerate: unreachable triggers are dropped", () => {
  it("skips a covered opener (centre hit is a non-descendant), keeps the combobox", async () => {
    const r = await run({ openerRect: VISIBLE, hit: "combo" });
    expect(r).toEqual({ opener: false, combo: true });
  });
  it("skips display:none, opacity:0 and zero-size openers", async () => {
    for (const openerStyle of ["display:none", "opacity:0", "visibility:hidden"]) {
      const r = await run({ openerRect: VISIBLE, openerStyle, hit: "combo" });
      expect(r.opener, openerStyle).toBe(false);
    }
    const z = await run({ openerRect: { left: 10, top: 10, width: 1, height: 1 }, hit: "combo" });
    expect(z.opener).toBe(false);
    expect(z.combo).toBe(true);
  });
  it("keeps an off-screen opener (cannot be hit-tested): two live candidates stay ambiguous", async () => {
    await expect(
      run({ openerRect: { left: 5000, top: 5000, width: 200, height: 30 }, hit: "combo" })
    ).rejects.toThrow(/no candidates/);
  });
});
