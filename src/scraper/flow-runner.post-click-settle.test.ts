import type Anthropic from "@anthropic-ai/sdk";
import type { Page, Stagehand } from "@browserbasehq/stagehand";
import type { Element as HappyDomElement } from "happy-dom";
import { Window } from "happy-dom";
import { describe, expect, it, vi } from "vitest";
import { verifySubmitWithLLM } from "@/lib/llm/judges/verify-submit";
import { settleAfterClick } from "@/scraper/click-settle";
import { runHealingFlow } from "@/scraper/flow-runner";
import type { Logger } from "@/types/logging";

vi.mock("@/lib/llm/judges/verify-submit", () => ({
  verifySubmitWithLLM: vi.fn(async () => ({ verified: true, reason: "confirmation visible" })),
}));

const MAX_MS = 15000;

function makeClock(onTick: (nowMs: number, counter: { n: number }) => void): {
  page: { waitForTimeout: (ms: number) => Promise<void> };
  counter: { n: number };
  now: () => number;
} {
  const counter = { n: 0 };
  let now = 0;
  const page = {
    waitForTimeout: async (ms: number): Promise<void> => {
      now += ms;
      onTick(now, counter);
    },
  };
  return { page, counter, now: () => now };
}

describe("settleAfterClick virtual clock", () => {
  it("returns well before the max when no activity is ever observed", async () => {
    const c = makeClock(() => {});
    await settleAfterClick(c.page, c.counter, 0);
    expect(c.now()).toBeGreaterThan(0);
    expect(c.now()).toBeLessThan(MAX_MS);
  });

  it("stops at the max on a continuous stream and not later", async () => {
    const c = makeClock((_, counter) => {
      counter.n += 1;
    });
    await settleAfterClick(c.page, c.counter, 0);
    expect(c.now()).toBe(MAX_MS);
  });

  it("waits for quiet after late activity instead of running to the max", async () => {
    const c = makeClock((now, counter) => {
      if (now === 6000) counter.n += 1;
    });
    await settleAfterClick(c.page, c.counter, 0);
    expect(c.now()).toBeGreaterThan(6000);
    expect(c.now()).toBeLessThan(MAX_MS);
  });
});

const BASE_URL = "https://apply.example.com/step/1";
const RERENDER_DELAY_MS = 8000;
const RERENDERED_TEXT = "Thanks, your application was received";

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
  for (const step of xp.split("/").filter(Boolean).slice(1)) {
    const m = /^([a-zA-Z0-9]+)\[(\d+)\]$/.exec(step);
    if (!current || !m) return null;
    const kids: HappyDomElement[] = Array.from(current.children).filter(
      (c: HappyDomElement) => c.tagName === m[1]?.toUpperCase()
    );
    current = kids[Number(m[2]) - 1] ?? null;
  }
  return current;
}

describe("flow-runner post-click settle end-to-end (8s delayed re-render)", () => {
  it("settles through the delayed re-render and hands the judge the re-rendered text", async () => {
    vi.mocked(verifySubmitWithLLM).mockClear();
    const window = new Window({ url: BASE_URL });
    const document = window.document;
    document.body.innerHTML = `
      <div><form id="theForm"><button id="theControl" type="submit">Continue</button></form>
      <div id="out"><p>Please wait</p></div><a id="detailsLink" href="#d">Details</a></div>`;
    const control = document.getElementById("theControl") as unknown as HappyDomElement;
    const out = document.getElementById("out") as unknown as HappyDomElement;
    const controlXPath = xpathFor(control);

    let now = 0;
    let clickedAt: number | null = null;
    let rendered = false;
    (
      control as unknown as { addEventListener: (t: string, cb: () => void) => void }
    ).addEventListener("click", () => {
      clickedAt = now;
    });

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
      url: () => BASE_URL,
      title: async () => "Apply — Step 1",
      locator: () => ({
        first: () => ({
          click: async () => (control as unknown as { click: () => void }).click(),
          isChecked: async () => false,
          inputValue: async () => "",
        }),
      }),
      waitForTimeout: async (ms: number): Promise<void> => {
        now += ms;
        if (clickedAt !== null && !rendered && now - clickedAt >= RERENDER_DELAY_MS) {
          rendered = true;
          out.innerHTML = `<p data-r="${"x".repeat(2000)}">${RERENDERED_TEXT}</p>`;
        }
      },
      getSessionForFrame: () => session,
      mainFrameId: () => "main",
      sendCDP: async () => ({ body: "{}", base64Encoded: false }),
    } as unknown as Page;

    const stagehand = {
      act: vi.fn().mockImplementation(async () => {
        (control as unknown as { click: () => void }).click();
        return {
          success: true,
          message: "clicked",
          actionDescription: "clicked",
          actions: [{ selector: `xpath=${controlXPath}`, description: "control", method: "click" }],
        };
      }),
      observe: vi
        .fn()
        .mockImplementation(async (i?: unknown) =>
          typeof i === "string" ? [] : [{ selector: "xpath=//probe-presence", description: "p" }]
        ),
    } as unknown as Stagehand;

    const info: string[] = [];
    const logger = {
      info: vi.fn((m: string) => info.push(m)),
      warn: vi.fn((m: string) => info.push(m)),
      error: vi.fn(),
      debug: vi.fn(),
    } as unknown as Logger;

    await runHealingFlow({
      stagehand,
      page,
      steps: [
        {
          instruction: "Click the button to continue",
          optional: false,
          upload: false,
          submitStep: true,
        },
        {
          instruction: "Click the 'Details' link",
          optional: true,
          upload: false,
          submitStep: false,
        },
      ],
      logger,
      anthropic: {} as Anthropic,
      rephraseModel: null,
      uploadFixture: null,
    }).catch(() => undefined);

    expect(rendered).toBe(true);
    expect(info.some((l) => l.includes("step 1/") && l.includes("succeeded"))).toBe(true);
    const calls = vi.mocked(verifySubmitWithLLM).mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    for (const [arg] of calls) {
      expect(arg.input.visibleText).toContain(RERENDERED_TEXT);
      expect(arg.input.stepInstruction).toBe("Click the button to continue");
    }
  });
});
