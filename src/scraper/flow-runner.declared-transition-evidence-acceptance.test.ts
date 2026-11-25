import type { Page, Stagehand } from "@browserbasehq/stagehand";
import {
  type Document,
  type Element,
  type HTMLElement,
  type HTMLInputElement,
  Window,
} from "happy-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { verifyStepAdvancedWithLLM } from "@/lib/llm/judges/verify-step-advanced";
import {
  declaresPageTransition,
  executeStepWithHealing,
  lacksTransitionEvidence,
} from "@/scraper/flow-runner";
import type { Logger } from "@/types/logging";

vi.mock("@/lib/llm/judges/verify-step-advanced", () => ({ verifyStepAdvancedWithLLM: vi.fn() }));
vi.mock("@/lib/llm/judges/verify-submit", () => ({ verifySubmitWithLLM: vi.fn() }));

const CONTINUE_STEP =
  "Click the button that continues to the order or checkout page (for example Book, Continue, or Checkout) so the contact details form appears.";
const BUTTON = "/html[1]/body[1]/main[1]/ul[1]/li[1]/button[1]";
const RADIO = "/html[1]/body[1]/main[1]/label[1]/input[1]";
const BODY = `<main><h1>Room page</h1><ul><li tabindex="0" class="slot"><button class="btn">Continue</button></li></ul><label><input type="radio" checked>6:00</label></main>`;

interface World {
  document: Document;
  url: string;
  counter: { n: number };
}

async function run(opts: {
  step?: string;
  xpath?: string;
  onClick?: (world: World) => void;
  /** Resolve nothing until observe, as a healed run does. */
  viaObserve?: boolean;
}): Promise<string> {
  const win = new Window({ url: "https://shop.example.test/room" });
  win.document.body.innerHTML = BODY;
  // happy-dom has no layout; every element of this page is on screen.
  const box = { x: 0, y: 0, top: 0, left: 0, right: 10, bottom: 10, width: 10, height: 10 };
  Object.assign(win.HTMLElement.prototype, {
    getBoundingClientRect: () => box,
    getClientRects: () => [box],
    checkVisibility: () => true,
  });
  const document = win.document;
  const world: World = { document, url: "https://shop.example.test/room", counter: { n: 0 } };
  const at = (xpath: string): Element | null =>
    xpath
      .split("/")
      .filter(Boolean)
      .reduce<Element | null>((el, part) => {
        const [, tag, index] = /^(\w+)\[(\d+)\]$/.exec(part) ?? [];
        if (tag === "html") return document.documentElement;
        const same = Array.from(el?.children ?? []).filter((c) => c.tagName.toLowerCase() === tag);
        return same[Number(index) - 1] ?? null;
      }, null);
  (document as unknown as { evaluate: unknown }).evaluate = (expr: string) => ({
    singleNodeValue: expr.startsWith("//") ? null : at(expr),
  });
  const xpath = opts.xpath ?? BUTTON;
  Object.assign(document, { elementFromPoint: () => at(xpath) });
  const click = (): void => opts.onClick?.(world);
  at(xpath)?.addEventListener("click", click);
  const session = { on: () => {}, off: () => {} };
  const page = {
    evaluate: async (expr: unknown) =>
      new Function(
        "document",
        "window",
        "getComputedStyle",
        "Node",
        "XPathResult",
        `return (${String(expr)});`
      )(document, win, win.getComputedStyle.bind(win), win.Node, { FIRST_ORDERED_NODE_TYPE: 9 }),
    url: () => world.url,
    title: async () => "Room",
    locator: (selector: string) => ({
      first: () => ({
        click: async () => (at(selector.replace(/^xpath=/, "")) as HTMLElement | null)?.click(),
        isChecked: async () =>
          (at(selector.replace(/^xpath=/, "")) as HTMLInputElement | null)?.checked === true,
        inputValue: async () => "",
      }),
    }),
    click: async () => (at(xpath) as HTMLElement | null)?.click(),
    waitForTimeout: async () => {},
    getSessionForFrame: () => session,
    mainFrameId: () => "main",
    sendCDP: async () => ({ body: "{}", base64Encoded: false }),
  } as unknown as Page;
  const action = { selector: `xpath=${xpath}`, description: "Continue", method: "click" };
  let acts = 0;
  const act = vi.fn().mockImplementation(async () => {
    acts += 1;
    if (opts.viaObserve && acts === 1) return { success: false, message: "none", actions: [] };
    (at(xpath) as HTMLElement | null)?.click();
    return { success: true, message: "clicked", actionDescription: "Continue", actions: [action] };
  });
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as unknown as Logger;
  const params = {
    stagehand: {
      act,
      observe: vi.fn().mockResolvedValue([action]),
    } as unknown as Stagehand,
    page,
    step: opts.step ?? CONTINUE_STEP,
    optional: false,
    upload: false,
    submitStep: false,
    stepIndex: 0,
    totalSteps: () => 3,
    phase: "flow",
    signalCounter: world.counter,
    trajectory: [],
    recentCaptures: [],
    recentCaptureMeta: [],
    anthropic: {},
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
  } as never;
  return executeStepWithHealing(params).catch((e: Error) => `threw ${e.stack}`);
}

const button = (w: World): Element => w.document.querySelector("button") as Element;
const STATE_ONLY: Array<[string, (w: World) => void]> = [
  ["a loading class", (w) => button(w).setAttribute("class", "btn loading")],
  ["an active class", (w) => button(w).setAttribute("class", "btn active")],
  ["a kind change", (w) => button(w).setAttribute("kind", "primary")],
  [
    "a selected parent",
    (w) => (button(w).parentElement as Element).setAttribute("class", "slot selected"),
  ],
];

describe("flow-runner declared page transition", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(verifyStepAdvancedWithLLM).mockResolvedValue({ advanced: false, reason: "same" });
  });

  it.each(STATE_ONLY)("is not credited on %s of the clicked control", async (_name, onClick) => {
    expect(await run({ onClick })).not.toBe("completed");
  });

  it("is not credited on a healed click's own state", async () => {
    const [, onClick] = STATE_ONLY[0] as (typeof STATE_ONLY)[number];
    expect(await run({ onClick, viaObserve: true })).not.toBe("completed");
  });

  it("is not credited because a radio was already checked", async () => {
    expect(await run({ xpath: RADIO })).not.toBe("completed");
  });

  it("is credited on a request, a URL change or a replaced page", async () => {
    vi.mocked(verifyStepAdvancedWithLLM).mockResolvedValue({ advanced: true, reason: "moved" });
    expect(
      await run({
        onClick: (w) => {
          w.counter.n += 1;
        },
      })
    ).toBe("completed");
    expect(
      await run({
        onClick: (w) => {
          w.url = "https://shop.example.test/checkout";
        },
      })
    ).toBe("completed");
    const replaced = `<main><h1>Contact details</h1>${"<p>Enter who the order is for and how to reach them.</p>".repeat(150)}</main>`;
    expect(
      await run({
        onClick: (w) => {
          w.document.body.innerHTML = replaced;
        },
      })
    ).toBe("completed");
  });

  it("leaves an option click credited by its own state", async () => {
    const onClick = (w: World): void => button(w).setAttribute("kind", "primary");
    const step = "Click the 'Continue' option so the salary field appears";
    expect(await run({ step, onClick })).toBe("completed");
  });

  it("reads the transition from the step, not from any mention of continuing", () => {
    for (const yes of [
      CONTINUE_STEP,
      "Proceed to checkout",
      "Click 'Save', which advances to the next section",
    ]) {
      expect(declaresPageTransition(yes), yes).toBe(true);
    }
    for (const no of [
      "Select 'Yes' and continue to the next page",
      "Click the 'Full time' option so the salary field appears",
      "Click the card; do not continue to checkout",
      "Click the 'Continue' button",
      null,
    ]) {
      expect(declaresPageTransition(no), String(no)).toBe(false);
    }
  });

  it("asks for evidence only of a declared transition", () => {
    const none = { networkAdvanced: false, urlChanged: false, pageAdvanced: false };
    expect(lacksTransitionEvidence({ step: CONTINUE_STEP, ...none })).toBe(true);
    expect(lacksTransitionEvidence({ step: "Click the 'Yes' option", ...none })).toBe(false);
    expect(lacksTransitionEvidence({ step: CONTINUE_STEP, ...none, pageAdvanced: true })).toBe(
      false
    );
  });
});
