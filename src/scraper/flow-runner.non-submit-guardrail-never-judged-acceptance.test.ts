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
 * Steps whose own instruction declares they are NOT a submit/checkout action
 * must never reach the submit judge, whatever the markup, position, attempt,
 * or flow-level submit config (`submitEndpointPattern` +
 * `requireSubmitEndpointMatch: true`, stated explicitly in every run below).
 */

const BASE_URL = "https://www.shop-fixture.example.com/products/item-7";
const STEPS: Array<[string, string]> = [
  [
    "category tab",
    "In the pricing panel, click on a category tab or link (e.g. 'Small', 'Large') to view that category's price. Do NOT click 'Add to Cart', 'Buy Now', 'Select', or any control that proceeds to checkout.",
  ],
  ["first list item", "Click the first item in the list. Do NOT click 'Add to Cart' or 'Buy Now'."],
  ["category tab without a guardrail", "In the pricing panel, click on a category tab to view that category's price."],
  ["continue tab with guardrail", "Click the 'Continue' tab. Do NOT click any control that proceeds to checkout."],
];
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
  ["sole button in a form-like container", { label: "Large", wrapInForm: true }],
  ["action-verb named sole button in a form-like container", { label: "Select", wrapInForm: true }],
  ["'Continue' tab in a form-like filter container", { label: "Continue", wrapInForm: true }],
];

const FILLER = {
  instruction: "Click the 'Details' link",
  optional: true,
  upload: false,
  submitStep: false,
};

async function run(params: {
  markup: Markup;
  instruction: string;
  submitStep: boolean;
  actClicks: boolean;
  final: boolean;
}): Promise<{ step1Verified: boolean; lines: string[] }> {
  const fx = buildFixture({ ...params.markup, actClicks: params.actClicks });
  await runHealingFlow({
    stagehand: fx.stagehand,
    page: fx.page,
    steps: [
      {
        instruction: params.instruction,
        optional: false,
        upload: false,
        submitStep: params.submitStep,
      },
      ...(params.final ? [] : [FILLER]),
    ],
    logger: fx.logger,
    anthropic: null,
    rephraseModel: null,
    uploadFixture: null,
    submitEndpointPattern: "/checkout/confirm$",
    requireSubmitEndpointMatch: true,
  }).catch(() => undefined);
  return {
    step1Verified: fx.info.some((l) => l.includes("step 1/") && l.includes("succeeded")),
    lines: [...fx.info, ...fx.warn],
  };
}

describe.each(MARKUPS)("declared non-submit steps are never judged — %s", (_m, markup) => {
  beforeEach(() => {
    vi.mocked(verifySubmitWithLLM).mockClear();
  });

  describe.each(STEPS)("%s", (_s, instruction) => {
    const cases: Array<[string, boolean, boolean]> = [
      ["interior step, primary attempt", true, false],
      ["interior step, n+16 retry", false, false],
      ["final step, primary attempt", true, true],
      ["final step, n+16 retry", false, true],
    ];
    it.each(cases)(
      "%s: credited by its own effect, judge uncalled",
      async (_c, actClicks, final) => {
        const { step1Verified, lines } = await run({
          markup,
          instruction,
          submitStep: false,
          actClicks,
          final,
        });
        expect(step1Verified).toBe(true);
        expect(verifySubmitWithLLM).not.toHaveBeenCalled();
        expect(lines.some((l) => l.includes("submit-judge-rejected"))).toBe(false);
      }
    );
  });

  it("control: a submitStep:true step still invokes the judge", async () => {
    await run({
      markup,
      instruction: "Click the 'Place Order' button",
      submitStep: true,
      actClicks: true,
      final: true,
    });
    expect(verifySubmitWithLLM).toHaveBeenCalled();
  });
});
