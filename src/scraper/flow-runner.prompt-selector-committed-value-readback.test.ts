import type { Page, Stagehand } from "@browserbasehq/stagehand";
import type { Element } from "happy-dom";
import { Window } from "happy-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { executeStepWithHealing } from "@/scraper/flow-runner";
import type { FrameTarget } from "@/scraper/frame-target";
import type { Logger } from "@/types/logging";

const QUESTION_LABEL = "Preferred Locations";
const OPTION = "Alpha";
const STEP = `for '${QUESTION_LABEL}' select '${OPTION}'`;
const OPTIONS = ["Alpha", "Beta"];

const testLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

type Announce = "describedby" | "chip" | "none";

const widgetHtml = (announce: Announce): string => `
<div data-automation-id="applyFlowMyInfoPage">
  <div role="group" aria-labelledby="loc-section">
    <span id="loc-section">${QUESTION_LABEL}</span>
    <div id="loc-widget" role="combobox" aria-haspopup="listbox" aria-invalid="false" tabindex="0">
      ${announce === "describedby" ? '<span id="loc-desc"></span><div id="loc-inner" aria-describedby="loc-desc"></div>' : ""}
      ${announce === "chip" ? '<span id="loc-desc">Expanded</span><div aria-describedby="loc-desc"></div><ul data-automation-id="selectedItemList"></ul>' : ""}
    </div>
  </div>
</div>`;

function buildHarness(params: { announce: Announce; commits: string; recycle?: boolean }): {
  page: unknown;
  target: FrameTarget;
} {
  const window = new Window({ url: "https://careers.example.com/apply/job/1" });
  const document = window.document;
  document.body.innerHTML = widgetHtml(params.announce);
  let popupOpen = false;

  const announce = (label: string): void => {
    if (params.announce === "describedby") {
      (document.getElementById("loc-desc") as Element).textContent = `1 item selected, ${label}`;
    } else if (params.announce === "chip") {
      (document.querySelector('[data-automation-id="selectedItemList"]') as Element).innerHTML =
        `<li>${label}</li>`;
    }
  };

  const renderPopup = (): void => {
    const widgetEl = document.getElementById("loc-widget") as Element;
    const wrap = document.createElement("div");
    wrap.setAttribute("data-test-popup", "1");
    wrap.innerHTML = `<ul role="listbox">${OPTIONS.map((o) => `<li role="option" data-automation-label="${o}">${o}</li>`).join("")}</ul>`;
    widgetEl.appendChild(wrap);
    popupOpen = true;
  };

  const commit = (): void => {
    document.querySelector("[data-test-popup]")?.remove();
    popupOpen = false;
    announce(params.commits);
  };

  const runExpr = (expr: string): unknown => {
    const fn = new window.Function("document", "window", "CSS", `return (${expr});`) as (
      d: unknown,
      w: unknown,
      c: unknown
    ) => unknown;
    return fn(document, window, window.CSS);
  };

  const resolveFirst = (selector: string): Element | null => {
    try {
      return document.querySelector(selector);
    } catch {
      return null;
    }
  };

  const locator = (selector: string) => ({
    click: async (): Promise<void> => locator(selector).first().click(),
    count: async (): Promise<number> => {
      try {
        return document.querySelectorAll(selector).length;
      } catch {
        return 0;
      }
    },
    first: () => ({
      click: async (): Promise<void> => {
        const el = resolveFirst(selector);
        if (!el) return;
        const inOpenPopup = el.closest("[data-test-popup]") !== null;
        if (inOpenPopup && el.getAttribute("role") === "option") {
          commit();
          return;
        }
        if (!popupOpen) {
          renderPopup();
        } else {
          document.querySelector("[data-test-popup]")?.remove();
          popupOpen = false;
        }
      },
      fill: async (): Promise<void> => undefined,
      isChecked: async (): Promise<boolean> => false,
      inputValue: async (): Promise<string> => "",
    }),
  });

  // happy-dom has no layout, so the trusted-click hit test is reported as a hit.
  const evaluate = async (expr: unknown): Promise<unknown> =>
    String(expr).includes('scrollIntoView({ block: "center"')
      ? { state: "hit" }
      : runExpr(String(expr));

  const page = {
    evaluate,
    url: () => "https://careers.example.com/apply/job/1",
    title: async (): Promise<string> => "Apply",
    locator,
    waitForTimeout: async (): Promise<void> => undefined,
  };

  const target = {
    evaluate,
    locator,
    url: async (): Promise<string> => "https://careers.example.com/apply/job/1",
    title: async (): Promise<string> => "Apply",
    frame: null,
    frameSelector: null,
    declaredFrameSelector: null,
  } as unknown as FrameTarget;

  return { page, target };
}

function baseParams(page: Page, stagehand: Stagehand, step: string, frameTarget: unknown) {
  return {
    stagehand,
    page,
    frameTarget,
    step,
    optional: false,
    upload: false,
    submitStep: false,
    stepIndex: 10,
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

async function run(h: { page: unknown; target: FrameTarget }): Promise<{
  result: unknown;
  trajectory: { stepIndex: number; verifiedBy: string; targetId?: string }[];
}> {
  const stagehand = {
    act: vi.fn(),
    observe: vi.fn().mockResolvedValue([]),
  } as unknown as Stagehand;
  const trajectory: { stepIndex: number; verifiedBy: string; targetId?: string }[] = [];
  const result = await executeStepWithHealing({
    ...baseParams(h.page as Page, stagehand, STEP, h.target),
    trajectory,
  } as never).catch(() => "threw");
  return { result, trajectory };
}

describe("flow-runner/commitPromptOption trusts the widget's announced committed value", () => {
  beforeEach(() => vi.clearAllMocks());

  it("does not credit a click that committed a different row while the widget stays valid", async () => {
    const { trajectory } = await run(buildHarness({ announce: "describedby", commits: "Beta" }));
    expect(trajectory).toEqual([]);
    expect(testLogger.info).toHaveBeenCalledWith(
      expect.stringContaining('committed "beta" instead of "Alpha"')
    );
  });

  it("credits a correct commit announced via a descendant's aria-describedby", async () => {
    const { trajectory } = await run(buildHarness({ announce: "describedby", commits: "Alpha" }));
    expect(trajectory).toEqual([{ stepIndex: 10, verifiedBy: "dom", targetId: "loc-widget" }]);
  });

  it("credits a correct commit via selectedItemList when the description reads Expanded", async () => {
    const { trajectory } = await run(buildHarness({ announce: "chip", commits: "Alpha" }));
    expect(trajectory).toEqual([{ stepIndex: 10, verifiedBy: "dom", targetId: "loc-widget" }]);
  });

  it("rejects a wrong commit read from selectedItemList", async () => {
    const { trajectory } = await run(buildHarness({ announce: "chip", commits: "Beta" }));
    expect(trajectory).toEqual([]);
    expect(testLogger.info).toHaveBeenCalledWith(expect.stringContaining('instead of "Alpha"'));
  });

  it("keeps the existing union when nothing is readable", async () => {
    const { trajectory } = await run(buildHarness({ announce: "none", commits: "Alpha" }));
    expect(trajectory).toEqual([{ stepIndex: 10, verifiedBy: "dom", targetId: "loc-widget" }]);
  });
});
