import type Anthropic from "@anthropic-ai/sdk";
import type { Page, Stagehand } from "@browserbasehq/stagehand";
import type { Element as HappyDomElement } from "happy-dom";
import { Window } from "happy-dom";
import { describe, expect, it, vi } from "vitest";
import { runHealingFlow } from "@/scraper/flow-runner";
import type { Logger } from "@/types/logging";

vi.mock("@/lib/llm/judges/verify-submit", () => ({
  verifySubmitWithLLM: vi.fn(async () => ({ verified: true, reason: "ok" })),
}));

const BASE_URL = "https://example.com/a";
const OPENED_URL = "https://example.com/b";

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

function makeNewPage(url: string): { page: Page; goto: ReturnType<typeof vi.fn> } {
  const goto = vi.fn(async () => undefined);
  const page = {
    url: () => url,
    goto,
    evaluate: vi.fn(async () => 6000),
    waitForLoadState: vi.fn(async () => {}),
    waitForTimeout: async (): Promise<void> => {},
    on: () => {},
    off: () => {},
  } as unknown as Page;
  return { page, goto };
}

describe("flow-runner new tab via window.open", () => {
  it('drives the page opened by a button\'s window.open("/b") for later steps', async () => {
    const window = new Window({ url: BASE_URL });
    const document = window.document;
    document.body.innerHTML = `<div><button id="opener" type="button">Open</button></div>`;
    const button = document.getElementById("opener") as unknown as HappyDomElement;
    const root = document.documentElement as unknown as HappyDomElement;
    const win = window as unknown as { XPathResult?: unknown };
    win.XPathResult = { FIRST_ORDERED_NODE_TYPE: 9 };
    (document as unknown as { evaluate: (e: string) => { singleNodeValue: unknown } }).evaluate = (
      e: string
    ) => ({ singleNodeValue: e.startsWith("//") ? null : resolveXPath(root, e) });

    const opened = makeNewPage(OPENED_URL);
    const pages: Page[] = [];
    const setActivePage = vi.fn();
    const context = { pages: () => [...pages], setActivePage };

    const session = { on: () => {}, off: () => {} };
    const first = {
      evaluate: async (expr: unknown): Promise<unknown> =>
        (
          new window.Function("document", "XPathResult", `return (${String(expr)});`) as (
            d: unknown,
            x: unknown
          ) => unknown
        )(document, win.XPathResult),
      url: () => BASE_URL,
      title: async () => "A",
      locator: () => ({
        first: () => ({
          click: async () => {},
          isChecked: async () => false,
          inputValue: async () => "",
        }),
      }),
      waitForTimeout: async (): Promise<void> => {},
      getSessionForFrame: () => session,
      mainFrameId: () => "main",
      sendCDP: async () => ({ body: "{}", base64Encoded: false }),
    } as unknown as Page;
    pages.push(first);

    button.addEventListener("click", () => {
      const url = new URL("/b", BASE_URL).toString();
      expect(url).toBe(OPENED_URL);
      pages.push(opened.page);
    });

    const stagehand = {
      context,
      act: vi.fn().mockImplementation(async () => {
        (button as unknown as { click: () => void }).click();
        return {
          success: true,
          message: "clicked",
          actionDescription: "clicked",
          actions: [
            {
              selector: "xpath=/html[1]/body[1]/div[1]/button[1]",
              description: "b",
              method: "click",
            },
          ],
        };
      }),
      observe: vi
        .fn()
        .mockImplementation(async (i?: unknown) =>
          typeof i === "string" ? [] : [{ selector: "xpath=//probe-presence", description: "p" }]
        ),
    } as unknown as Stagehand;

    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    } as unknown as Logger;

    await runHealingFlow({
      stagehand,
      page: first,
      steps: [
        { instruction: "Click the Open button", optional: false, upload: false, submitStep: false },
        {
          instruction: "unused",
          navigateTo: "https://example.com/next",
          optional: false,
          upload: false,
          submitStep: false,
        },
      ],
      logger,
      anthropic: {} as Anthropic,
      rephraseModel: null,
      uploadFixture: null,
    }).catch(() => undefined);

    expect(setActivePage).toHaveBeenCalledWith(opened.page);
    expect((opened.page as unknown as { url: () => string }).url().endsWith("/b")).toBe(true);
    expect(opened.goto).toHaveBeenCalled();
  });
});
