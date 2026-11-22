import type { Page, Stagehand } from "@browserbasehq/stagehand";
import type { Element } from "happy-dom";
import { Window } from "happy-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { executeStepWithHealing, isMidFlowAdvanceCredited } from "@/scraper/flow-runner";
import type { FrameTarget } from "@/scraper/frame-target";
import type { Logger } from "@/types/logging";

const QUESTION_LABEL = "How Did You Hear About Us?";
const OPTION = "Alpha";
const STEP = `in the '${QUESTION_LABEL}' prompt selector, select '${OPTION}'`;
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
      ${announce === "none" ? '<span data-automation-id="promptSelectionLabel"></span>' : ""}
    </div>
  </div>
</div>`;

function buildHarness(params: { announce: Announce; commits: string | null; recycle?: boolean }): {
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
    } else if (params.announce === "none") {
      (
        document.querySelector('[data-automation-id="promptSelectionLabel"]') as Element
      ).textContent = label;
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
    if (params.commits !== null) announce(params.commits);
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
          // commits === null: the popup stays open and nothing is committed.
          if (params.commits === null) return;
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

describe("primary path: a select step whose popup merely opens is not verified", () => {
  beforeEach(() => vi.clearAllMocks());

  it("does not credit DOM growth from an opened popup with an unchanged target", async () => {
    const { trajectory } = await run(buildHarness({ announce: "none", commits: null }));
    expect(trajectory).toEqual([]);
  });

  it("still credits once the value is committed", async () => {
    const { trajectory } = await run(buildHarness({ announce: "none", commits: "Alpha" }));
    expect(trajectory).toEqual([{ stepIndex: 10, verifiedBy: "dom", targetId: "loc-widget" }]);
  });
});

describe("n+16 fallback: a select step whose popup opens is not verified", () => {
  const FALLBACK_URL = "https://apply.example.com/application/experience";
  const FALLBACK_STEP = "Select 'Alpha' for the Industry field";

  function xpathOf(el: Element): string {
    const steps: string[] = [];
    let node: Element | null = el;
    while (node) {
      const cur: Element = node;
      const parent: Element | null = cur.parentElement;
      if (!parent) {
        steps.unshift(`${cur.tagName.toLowerCase()}[1]`);
        break;
      }
      const same = Array.from(parent.children).filter((c) => c.tagName === cur.tagName);
      steps.unshift(`${cur.tagName.toLowerCase()}[${same.indexOf(cur) + 1}]`);
      node = parent;
    }
    return `/${steps.join("/")}`;
  }

  function resolveXPath(root: Element, xp: string): Element | null {
    let cur: Element | null = root;
    for (const s of xp.split("/").filter(Boolean).slice(1)) {
      const m = /^([a-z0-9]+)\[(\d+)\]$/i.exec(s);
      if (!cur || !m) return null;
      cur =
        Array.from(cur.children).filter((c) => c.tagName === m[1]?.toUpperCase())[
          Number(m[2]) - 1
        ] ?? null;
    }
    return cur;
  }

  function fallbackHarness(commitValue: boolean) {
    const window = new Window({ url: FALLBACK_URL });
    const document = window.document;
    document.body.innerHTML = `<div><a id="opener" href="#">Industry</a></div>`;
    const opener = document.getElementById("opener") as unknown as Element;
    const xp = xpathOf(opener);
    opener.addEventListener("click", () => {
      document.body.innerHTML = `<div><a id="opener" href="#">Industry</a>
        <input id="industry" type="text" value="${commitValue ? "Alpha" : ""}" />
        <ul role="listbox"><li role="option">Alpha</li><li role="option">Beta</li></ul></div>
        <p>popup open</p>`;
    });
    (document as unknown as { elementFromPoint: () => unknown }).elementFromPoint = () =>
      document.getElementById("opener");
    const root = document.documentElement as unknown as Element;
    const win = window as unknown as { XPathResult?: unknown };
    win.XPathResult = { FIRST_ORDERED_NODE_TYPE: 9 };
    (document as unknown as { evaluate: (e: string) => unknown }).evaluate = (e: string) => ({
      singleNodeValue: e.startsWith("//") ? null : resolveXPath(root, e),
    });
    const session = { on: () => {}, off: () => {} };
    const page = {
      evaluate: async (expr: unknown): Promise<unknown> =>
        (
          new window.Function("document", "XPathResult", `return (${String(expr)});`) as (
            ...a: unknown[]
          ) => unknown
        )(document, win.XPathResult),
      url: () => FALLBACK_URL,
      title: async () => "Experience",
      // Trusted click fails so the synthetic el.click() fallback is used.
      locator: () => ({
        first: () => ({
          click: async () => {
            throw new Error("not actionable");
          },
          isChecked: async () => false,
          inputValue: async () => "",
        }),
      }),
      waitForTimeout: async () => {},
      getSessionForFrame: () => session,
      mainFrameId: () => "main",
      sendCDP: async () => ({ body: "{}", base64Encoded: false }),
    } as unknown as Page;
    const stagehand = {
      act: vi.fn().mockResolvedValue({
        success: true,
        message: "clicked",
        actionDescription: FALLBACK_STEP,
        actions: [{ selector: `xpath=${xp}`, description: "Industry", method: "click" }],
      }),
      observe: vi
        .fn()
        .mockImplementation(async (i?: unknown) =>
          typeof i === "string" ? [] : [{ selector: "xpath=//probe", description: "probe" }]
        ),
    } as unknown as Stagehand;
    return { page, stagehand };
  }

  const go = (h: ReturnType<typeof fallbackHarness>) =>
    executeStepWithHealing({
      ...baseParams(h.page as Page, h.stagehand, FALLBACK_STEP, null),
      flowHasSubmitSemantics: false,
      stepIndex: 0,
      totalSteps: () => 3,
      phase: "flow",
      onStepFailure: () => null,
    } as never);

  it("does not credit an opened popup when the target is unchanged", async () => {
    await expect(go(fallbackHarness(false))).rejects.toThrow(/verification|attempts/i);
    expect(testLogger.info).toHaveBeenCalledWith(
      expect.stringContaining("select step target value unchanged")
    );
  });

  it("credits when the target committed the value", async () => {
    expect(await go(fallbackHarness(true))).toBeTruthy();
  });
});

describe("mid-flow submit judge rejection (Save and Continue ... advance to the next step)", () => {
  const base = {
    midFlowSubmit: true,
    signalAdvanced: true,
    judgeUnavailable: false,
    networkAdvanced: false,
    pageAdvanced: false,
    invalidMarkerCount: 0,
  };

  it("does not credit a view-swap-only signal over an explicit judge rejection", () => {
    expect(isMidFlowAdvanceCredited(base)).toBe(false);
  });

  it("credits when the judge is unavailable", () => {
    expect(isMidFlowAdvanceCredited({ ...base, judgeUnavailable: true })).toBe(true);
  });

  it("credits a rejected judge only with a settled page or network advance", () => {
    expect(isMidFlowAdvanceCredited({ ...base, pageAdvanced: true })).toBe(true);
    expect(isMidFlowAdvanceCredited({ ...base, networkAdvanced: true })).toBe(true);
  });
});
