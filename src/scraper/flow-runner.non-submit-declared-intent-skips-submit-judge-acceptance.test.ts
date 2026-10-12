import type { Page, Stagehand } from "@browserbasehq/stagehand";
import type { Element as HappyDomElement } from "happy-dom";
import { Window } from "happy-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { verifySubmitWithLLM } from "@/lib/llm/judges/verify-submit";
import { runHealingFlow } from "@/scraper/flow-runner";
import type { Logger } from "@/types/logging";

vi.mock("@/lib/llm/judges/verify-submit", () => ({
  verifySubmitWithLLM: vi.fn(async () => ({
    verified: false,
    reason: "no post-submit signal",
  })),
}));

/**
 * A pricing-panel category tab click whose instruction explicitly declares it
 * is NOT a checkout click must never be classified submit-shaped nor judged by
 * the submit judge, even when the flow declares `requireSubmitEndpointMatch` +
 * `submitEndpointPattern` (no `submitStep` flag) and the target's markup looks
 * like a submit control (generic action verb label, or the sole button in a
 * form). Primary attempt and n+16 retry are pinned separately.
 */

const BASE_URL = "https://www.rental-fixture.example.com/listings/unit-42";
const STEP =
  "In the pricing panel, click on a category tab or link (e.g. Inside, Outside) to view that category's price. Do NOT click Book Now, Reserve, Select, or any control that proceeds to checkout";

function makeLogger(): { logger: Logger; info: string[]; warn: string[] } {
  const info: string[] = [];
  const warn: string[] = [];
  const logger = {
    info: vi.fn((msg: string) => info.push(msg)),
    warn: vi.fn((msg: string) => warn.push(msg)),
    error: vi.fn(),
    debug: vi.fn(),
  } as unknown as Logger;
  return { logger, info, warn };
}

function absoluteXPathFor(el: HappyDomElement): string {
  const steps: string[] = [];
  let node: HappyDomElement | null = el;
  while (node) {
    const currentNode: HappyDomElement = node;
    const parent: HappyDomElement | null = currentNode.parentElement;
    if (!parent) {
      steps.unshift(`${currentNode.tagName.toLowerCase()}[1]`);
      break;
    }
    const sameTag = Array.from(parent.children).filter(
      (c: HappyDomElement) => c.tagName === currentNode.tagName
    );
    steps.unshift(`${currentNode.tagName.toLowerCase()}[${sameTag.indexOf(currentNode) + 1}]`);
    node = parent;
  }
  return `/${steps.join("/")}`;
}

function resolveAbsoluteXPath(root: HappyDomElement, xp: string): HappyDomElement | null {
  const steps = xp
    .split("/")
    .filter(Boolean)
    .map((step) => {
      const match = /^([a-zA-Z0-9]+)\[(\d+)\]$/.exec(step);
      if (!match) throw new Error(`unsupported xpath step in test fixture: ${step}`);
      return { tag: match[1]?.toUpperCase(), idx: Number(match[2]) };
    });
  let current: HappyDomElement | null = root;
  for (const step of steps.slice(1)) {
    if (!current) return null;
    const candidates: HappyDomElement[] = Array.from(current.children).filter(
      (c: HappyDomElement) => c.tagName === step.tag
    );
    current = candidates[step.idx - 1] ?? null;
  }
  return current;
}

interface Markup {
  label: string;
  wrapInForm: boolean;
}

function buildFixture(params: Markup & { actClicks: boolean }): {
  page: Page;
  stagehand: Stagehand;
  logger: Logger;
  info: string[];
  warn: string[];
} {
  const window = new Window({ url: BASE_URL });
  const document = window.document;
  const open = params.wrapInForm ? '<form id="panelForm">' : "<div>";
  const close = params.wrapInForm ? "</form>" : "</div>";
  document.body.innerHTML = `
    <div class="pricingPanel">
      ${open}
        <button id="theControl" type="button">${params.label}</button>
      ${close}
      <div id="prices"><p>Inside: $100</p></div>
    </div>
  `;
  const controlEl = document.getElementById("theControl") as unknown as HappyDomElement;
  const pricesEl = document.getElementById("prices") as unknown as HappyDomElement;
  if (!controlEl || !pricesEl) throw new Error("fixture setup failed");
  const controlXPath = absoluteXPathFor(controlEl);
  let currentUrl = BASE_URL;

  (
    controlEl as unknown as { addEventListener: (t: string, cb: () => void) => void }
  ).addEventListener("click", () => {
    currentUrl = `${BASE_URL}/outside`;
    pricesEl.innerHTML = `<p data-outside="${"x".repeat(2000)}">Outside: $80</p>`;
  });

  const documentElement = document.documentElement as unknown as HappyDomElement;
  const win = window as unknown as { XPathResult?: unknown };
  win.XPathResult = { FIRST_ORDERED_NODE_TYPE: 9 };
  (document as unknown as { evaluate: (expr: string) => { singleNodeValue: unknown } }).evaluate = (
    expr: string
  ) => ({
    singleNodeValue: expr.startsWith("//") ? null : resolveAbsoluteXPath(documentElement, expr),
  });

  const session = { on: () => {}, off: () => {} };
  const page = {
    evaluate: async (expr: unknown): Promise<unknown> => {
      const fn = new window.Function("document", "XPathResult", `return (${String(expr)});`) as (
        d: unknown,
        x: unknown
      ) => unknown;
      return fn(document, win.XPathResult);
    },
    url: () => currentUrl,
    title: async () => "Unit 42 | Rental Fixture",
    locator: () => ({
      first: () => ({
        click: async () => {
          (controlEl as unknown as { click: () => void }).click();
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
    act: vi.fn().mockImplementation(async () => {
      if (params.actClicks) (controlEl as unknown as { click: () => void }).click();
      return {
        success: true,
        message: "clicked",
        actionDescription: "clicked",
        actions: [{ selector: `xpath=${controlXPath}`, description: "category", method: "click" }],
      };
    }),
    observe: vi
      .fn()
      .mockImplementation(async (instruction?: unknown) =>
        typeof instruction === "string"
          ? []
          : [{ selector: "xpath=//probe-presence", description: "probe-presence" }]
      ),
  } as unknown as Stagehand;

  const { logger, info, warn } = makeLogger();
  return { page, stagehand, logger, info, warn };
}

const MARKUPS: Array<[string, Markup]> = [
  ["generic-verb-named control", { label: "Continue", wrapInForm: false }],
  ["sole button in a form ancestor", { label: "Outside", wrapInForm: true }],
];

describe.each(MARKUPS)(
  "non-submit declared intent skips the submit judge — %s",
  (_name, markup) => {
    beforeEach(() => {
      vi.mocked(verifySubmitWithLLM).mockClear();
    });

    const run = async (
      actClicks: boolean
    ): Promise<{ lastStepIndex: number; info: string[]; warn: string[] }> => {
      const fx = buildFixture({ ...markup, actClicks });
      const result = await runHealingFlow({
        stagehand: fx.stagehand,
        page: fx.page,
        steps: [{ instruction: STEP, optional: false, upload: false, submitStep: false }],
        logger: fx.logger,
        anthropic: null,
        rephraseModel: null,
        uploadFixture: null,
        submitEndpointPattern: "/bookings/confirm$",
        requireSubmitEndpointMatch: true,
      });
      return { lastStepIndex: result.lastStepIndex, info: fx.info, warn: fx.warn };
    };

    const rejected = (lines: string[]): boolean =>
      lines.some((l) => l.includes("submit-judge-rejected"));

    it("primary attempt: verifies via view-swap credit without invoking the judge", async () => {
      const { lastStepIndex, info, warn } = await run(true);
      expect(lastStepIndex).toBe(0);
      expect(verifySubmitWithLLM).not.toHaveBeenCalled();
      expect(rejected([...info, ...warn])).toBe(false);
    });

    it("n+16 retry: verifies via DOM credit without invoking the judge", async () => {
      const { lastStepIndex, info, warn } = await run(false);
      expect(lastStepIndex).toBe(0);
      expect(verifySubmitWithLLM).not.toHaveBeenCalled();
      expect(rejected([...info, ...warn])).toBe(false);
    });
  }
);
