import type { Page, Stagehand } from "@browserbasehq/stagehand";
import type { Element as HappyDomElement } from "happy-dom";
import { Window } from "happy-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { verifyStepAdvancedWithLLM } from "@/lib/llm/judges/verify-step-advanced";
import { verifySubmitWithLLM } from "@/lib/llm/judges/verify-submit";
import { executeStepWithHealing } from "@/scraper/flow-runner";
import type { Logger } from "@/types/logging";

vi.mock("@/lib/llm/judges/verify-submit", () => ({ verifySubmitWithLLM: vi.fn() }));
vi.mock("@/lib/llm/judges/verify-step-advanced", () => ({ verifyStepAdvancedWithLLM: vi.fn() }));

const URL = "https://wizard.example.test/apply/step-1";
const testLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

type Reveal = "text" | "aria-invalid" | "popup";

function xpathFor(el: HappyDomElement): string {
  const parts: string[] = [];
  let node: HappyDomElement | null = el;
  while (node) {
    const cur: HappyDomElement = node;
    const parent: HappyDomElement | null = cur.parentElement;
    if (!parent) {
      parts.unshift(`${cur.tagName.toLowerCase()}[1]`);
      break;
    }
    const same = Array.from(parent.children).filter(
      (c: HappyDomElement) => c.tagName === cur.tagName
    );
    parts.unshift(`${cur.tagName.toLowerCase()}[${same.indexOf(cur) + 1}]`);
    node = parent;
  }
  return `/${parts.join("/")}`;
}

function resolveXPath(root: HappyDomElement, xp: string): HappyDomElement | null {
  let current: HappyDomElement | null = root;
  for (const part of xp.split("/").filter(Boolean).slice(1)) {
    const m = /^([a-zA-Z0-9]+)\[(\d+)\]$/.exec(part);
    if (!current || !m) return null;
    const kids: HappyDomElement[] = Array.from(current.children).filter(
      (c: HappyDomElement) => c.tagName === m[1]?.toUpperCase()
    );
    current = kids[Number(m[2]) - 1] ?? null;
  }
  return current;
}

function build(reveal: Reveal): { page: Page; stagehand: Stagehand; counter: { n: number } } {
  const window = new Window({ url: URL });
  const document = window.document;
  document.body.innerHTML = `
    <div><h1>My Information</h1><p>Step 1 of 7</p>
    <form><label for="f1">Referral source</label><input id="f1" type="text" /></form>
    <span id="go" class="chevron">&rsaquo;</span>
    <div id="out"></div></div>`;
  const control = document.getElementById("go") as unknown as HappyDomElement;
  const out = document.getElementById("out") as unknown as HappyDomElement;
  const field = document.getElementById("f1") as unknown as HappyDomElement;
  const pad = `<i data-pad="${"x".repeat(6000)}"></i>`;
  const click = (): void => {
    if (reveal === "text") {
      out.innerHTML = `${pad}<p>This field is required</p>`;
    } else if (reveal === "aria-invalid") {
      field.setAttribute("aria-invalid", "true");
      out.innerHTML = `${pad}<p>Please complete this field</p>`;
    } else {
      out.innerHTML = `${pad}<ul role="listbox"><li role="option">Alpha</li><li role="option">Beta</li></ul>`;
    }
  };
  (
    control as unknown as { addEventListener: (t: string, cb: () => void) => void }
  ).addEventListener("click", click);
  const controlXPath = xpathFor(control);
  const root = document.documentElement as unknown as HappyDomElement;
  const win = window as unknown as { XPathResult?: unknown };
  win.XPathResult = { FIRST_ORDERED_NODE_TYPE: 9 };
  (document as unknown as { evaluate: (e: string) => { singleNodeValue: unknown } }).evaluate = (
    e: string
  ) => ({ singleNodeValue: e.startsWith("//") ? null : resolveXPath(root, e) });
  const session = { on: () => {}, off: () => {} };
  const page = {
    evaluate: async (expr: unknown): Promise<unknown> =>
      (
        new window.Function("document", "XPathResult", `return (${String(expr)});`) as (
          d: unknown,
          x: unknown
        ) => unknown
      )(document, win.XPathResult),
    url: () => URL,
    title: async () => "Apply",
    locator: () => ({
      first: () => ({
        click: async () => (control as unknown as { click: () => void }).click(),
        isChecked: async () => false,
        inputValue: async () => "",
      }),
    }),
    waitForTimeout: async (): Promise<void> => {},
    getSessionForFrame: () => session,
    mainFrameId: () => "main",
    sendCDP: async () => ({ body: "{}", base64Encoded: false }),
  } as unknown as Page;
  const act = vi.fn().mockImplementation(async () => {
    (control as unknown as { click: () => void }).click();
    return {
      success: true,
      message: "clicked",
      actionDescription: "clicked",
      actions: [
        { selector: `xpath=${controlXPath}`, description: "Save and Continue", method: "click" },
      ],
    };
  });
  const stagehand = {
    act,
    observe: vi
      .fn()
      .mockImplementation(async (i?: unknown) =>
        typeof i === "string" ? [] : [{ selector: "xpath=//probe-presence", description: "p" }]
      ),
  } as unknown as Stagehand;
  return { page, stagehand, counter: { n: 0 } };
}

function params(w: ReturnType<typeof build>, step: string): never {
  return {
    stagehand: w.stagehand,
    page: w.page,
    step,
    optional: false,
    upload: false,
    submitStep: false,
    stepIndex: 0,
    totalSteps: () => 3,
    phase: "flow",
    signalCounter: w.counter,
    trajectory: [],
    recentCaptures: [],
    recentCaptureMeta: [],
    anthropic: {},
    rephraseModel: null,
    logger: testLogger,
    uploadFixture: null,
    isFinalStep: false,
    submitEndpointPattern: null,
    submittedStateSelectors: [],
    requireSubmitEndpointMatch: false,
    flowHasSubmitSemantics: false,
    advanceTransitionBodyPattern: null,
    successUrlFragments: [],
    successPageTitleHints: [],
    ownBackendHostnames: [],
    knownErrorClassPrefixes: [],
    wizardExitButtonLabels: [],
    onStepFailure: () => null,
  } as never;
}

const STEPS = [
  "Click the 'Save and Continue' button to save My Information and advance to the My Experience step",
  "Click the 'Save and Continue' button to save the profile and advance to the next step",
  "Click the 'Continue' button to advance to the Review step",
];

describe("mid-flow advance click the judge rejected, weak client-side signal only", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(verifySubmitWithLLM).mockResolvedValue({
      verified: false,
      reason: "still on step 1",
    } as never);
    vi.mocked(verifyStepAdvancedWithLLM).mockResolvedValue({
      advanced: false,
      reason: "still on step 1",
    });
  });
  for (const reveal of ["text", "aria-invalid", "popup"] as const) {
    for (const step of STEPS) {
      it(`${reveal}: ${step}`, async () => {
        const w = build(reveal);
        const outcome = await executeStepWithHealing(params(w, step)).catch(() => "threw");
        expect(outcome).not.toBe("completed");
      });
    }
  }
});
