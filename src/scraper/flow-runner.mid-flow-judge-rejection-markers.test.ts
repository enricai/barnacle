import type { Page, Stagehand } from "@browserbasehq/stagehand";
import { Window } from "happy-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { verifyStepAdvancedWithLLM } from "@/lib/llm/judges/verify-step-advanced";
import { executeStepWithHealing } from "@/scraper/flow-runner";
import type { Logger } from "@/types/logging";

vi.mock("@/lib/llm/judges/verify-step-advanced", () => ({
  verifyStepAdvancedWithLLM: vi.fn(),
}));

const URL = "https://wizard.example.com/apply/step-1";
const STEPS = [
  "Click the 'Save and Continue' button to save My Information and advance to the My Experience step",
  "Press 'Next' to proceed to the following section",
];

const MARKERS = {
  errorMessage: `<div data-automation-id="errorMessage">Please enter a value in this field.</div>`,
  errorBanner: `<div data-automation-id="errorBanner">Errors found, fix them to continue.</div>`,
  ariaInvalid: "",
  none: "",
} as const;
type Marker = keyof typeof MARKERS;

const BASE = `current step 1 of 7 My Information ${"Fill in the required fields below. ".repeat(12)}`;
// +1 for the separator the visible-text read puts before an added block.
const markerTextLength = (m: Marker): number =>
  MARKERS[m] === "" ? 0 : MARKERS[m].replace(/<[^>]*>/g, "").length + 1;
const logger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
} as unknown as Logger;

function buildWorld(marker: Marker, opts: { swapText: string; network?: boolean; popup?: boolean }) {
  const handlers = new Map<string, (p: unknown) => void | Promise<void>>();
  const window = new Window({ url: URL });
  const document = window.document;
  document.body.innerHTML = `<div id="root"><p id="txt">${BASE}</p>
    <input id="f" aria-invalid="false" /><button id="go">Save and Continue</button></div>`;
  const root = document.documentElement;
  const win = window as unknown as { XPathResult?: unknown };
  win.XPathResult = { FIRST_ORDERED_NODE_TYPE: 9 };
  const go = document.getElementById("go") as unknown as { click: () => void };
  const click = () => {
    if (opts.popup) {
      // A select popup opens; the committed value never changes.
      document
        .getElementById("root")
        ?.insertAdjacentHTML(
          "beforeend",
          `<ul role="listbox"><li role="option">Alpha</li><li role="option">Beta</li></ul><i data-pad="${"x".repeat(4000)}"></i>`
        );
      return;
    }
    if (opts.network) {
      const request = { url: "https://api.example.com/apply/step", method: "POST", headers: {} };
      void handlers.get("Network.requestWillBeSent")?.({ requestId: "r1", request });
      void handlers.get("Network.responseReceived")?.({
        requestId: "r1",
        response: {
          url: request.url,
          status: 200,
          mimeType: "application/json",
          headers: { "content-type": "application/json" },
        },
      });
      void handlers.get("Network.loadingFinished")?.({ requestId: "r1" });
    }
    (document.getElementById("txt") as unknown as { textContent: string }).textContent =
      opts.swapText.slice(0, BASE.length - markerTextLength(marker)) +
      // aria-invalid adds no text node, so the control's own flag is the only growth;
      // one extra character keeps the sibling step-start credit's text-growth veto engaged.
      (marker === "ariaInvalid" ? "!" : "");
    // Reveal-sized DOM growth so the click earns view-swap credit on bytes.
    document
      .getElementById("root")
      ?.insertAdjacentHTML("beforeend", `<i data-pad="${"x".repeat(4000)}"></i>`);
    if (marker === "ariaInvalid")
      document.getElementById("f")?.setAttribute("aria-invalid", "true");
    else if (marker !== "none")
      document.getElementById("root")?.insertAdjacentHTML("beforeend", MARKERS[marker]);
  };
  document.getElementById("go")?.addEventListener("click", click);
  (document as unknown as { evaluate: (e: string) => unknown }).evaluate = (e: string) => ({
    singleNodeValue: e.startsWith("//") ? null : document.getElementById("go"),
  });
  void root;
  const session = {
    on: (e: string, h: (p: unknown) => void | Promise<void>) => handlers.set(e, h),
    off: () => {},
  };
  const page = {
    evaluate: async (expr: unknown) =>
      (
        new window.Function("document", "XPathResult", `return (${String(expr)});`) as (
          ...a: unknown[]
        ) => unknown
      )(document, win.XPathResult),
    url: () => URL,
    title: async () => "Apply",
    locator: () => ({
      first: () => ({
        click: async () => go.click(),
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
    act: vi.fn().mockImplementation(async () => {
      go.click();
      return {
        success: true,
        message: "clicked",
        actionDescription: "clicked",
        actions: [
          {
            selector: "xpath=/html[1]/body[1]/div[1]/button[1]",
            description: "go",
            method: "click",
          },
        ],
      };
    }),
    observe: vi
      .fn()
      .mockImplementation(async (i?: unknown) =>
        typeof i === "string" ? [] : [{ selector: "xpath=//probe", description: "probe" }]
      ),
  } as unknown as Stagehand;
  return { page, stagehand };
}

async function run(
  marker: Marker,
  opts: { swapText: string; step?: string; judge: boolean; network?: boolean; popup?: boolean }
): Promise<{ outcome: unknown; trajectory: unknown[] }> {
  const w = buildWorld(marker, opts);
  const trajectory: unknown[] = [];
  const outcome = await executeStepWithHealing({
    stagehand: w.stagehand,
    page: w.page,
    step: opts.step ?? STEPS[0],
    optional: false,
    upload: false,
    submitStep: false,
    stepIndex: 0,
    totalSteps: () => 3,
    phase: "flow",
    signalCounter: { n: 0 },
    trajectory,
    recentCaptures: [],
    recentCaptureMeta: [],
    anthropic: opts.judge ? {} : null,
    rephraseModel: null,
    logger,
    uploadFixture: null,
    isFinalStep: false,
    flowHasSubmitSemantics: false,
    submitEndpointPattern: null,
    submittedStateSelectors: [],
    requireSubmitEndpointMatch: false,
    advanceTransitionBodyPattern: null,
    successUrlFragments: [],
    successPageTitleHints: [],
    ownBackendHostnames: [],
    knownErrorClassPrefixes: [],
    wizardExitButtonLabels: [],
    onStepFailure: () => null,
  } as never).catch(() => "threw");
  return { outcome, trajectory };
}

// Same length as the original text: a settled equal-length swap.
// A different body of the same length: a settled equal-length swap.
const SWAP = "Zebra quartz vexing jumbled folks ".repeat(20).slice(0, BASE.length);
const REJECT = { advanced: false, reason: "The page still shows 'current step 1 of 7'." };

describe("judge-rejected mid-flow submit with non-Angular validation markers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(verifyStepAdvancedWithLLM).mockResolvedValue(REJECT);
  });

  for (const marker of ["errorMessage", "errorBanner", "ariaInvalid"] as const) {
    it(`does not credit a text swap that grew an ${marker} marker`, async () => {
      const { outcome, trajectory } = await run(marker, { swapText: SWAP, judge: true });
      expect(outcome).toBe("threw");
      expect(trajectory).toEqual([]);
    });
  }

  it("does not credit a differently worded step", async () => {
    const { outcome, trajectory } = await run("errorMessage", {
      swapText: SWAP,
      step: STEPS[1],
      judge: true,
    });
    expect(outcome).toBe("threw");
    expect(trajectory).toEqual([]);
  });

  it("null judge keeps crediting a view-swap with no marker growth", async () => {
    const { outcome } = await run("none", { swapText: SWAP, judge: false });
    expect(outcome).toBe("completed");
  });

  it("credits a rejected judge when the page demonstrably advanced with no marker growth", async () => {
    const { outcome } = await run("none", {
      swapText: `current step 2 of 7 My Experience ${"resume upload ".repeat(60)}`,
      judge: true,
    });
    expect(outcome).toBe("completed");
  });

  it("credits a rejected judge on a real network advance with no marker growth", async () => {
    const { outcome } = await run("none", { swapText: SWAP, judge: true, network: true });
    expect(outcome).toBe("completed");
  });

  it("does not credit a select popup that opens with the committed value unchanged", async () => {
    const { outcome, trajectory } = await run("none", {
      swapText: SWAP,
      judge: true,
      popup: true,
      step: "In the 'Preferred Contact Method?' prompt selector, select 'Alpha'",
    });
    expect(outcome).toBe("threw");
    expect(trajectory).toEqual([]);
  });
});
