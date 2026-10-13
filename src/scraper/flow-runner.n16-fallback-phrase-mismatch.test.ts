import type { Page, Stagehand } from "@browserbasehq/stagehand";
import type { Element as HappyDomElement } from "happy-dom";
import { Window } from "happy-dom";
import { describe, expect, it, vi } from "vitest";
import { type HealingFlowStep, runHealingFlow } from "@/scraper/flow-runner";
import type { Logger } from "@/types/logging";

/**
 * Pins the n+16 fallback's phrase guard: a stale primary xpath whose loose
 * tail resolves to a control that names none of the step's quoted phrases
 * must not be clicked (probe reports `{fired:false, phraseMismatch:true}`),
 * while a phrase-matching retarget, and fill/select/radio steps (which yield
 * no phrases), keep the unrestricted retarget.
 */

const BASE_URL = "https://apply.example.com/step/1";
const STALE_XPATH = "/html[1]/body[1]/div[1]/div[1]/div[1]/button[1]";
const CLICK_STEP = "under the text 'Don't have an account yet?', click the 'Create Account' button";

interface ProbeResult {
  fired?: boolean;
  phraseMismatch?: boolean;
}

function makeLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as unknown as Logger;
}

function parseXPathSteps(xp: string): { tag: string; idx: number }[] {
  return xp
    .split("/")
    .filter(Boolean)
    .map((step) => {
      const match = /^([a-zA-Z0-9]+)\[(\d+)\]$/.exec(step);
      if (!match) throw new Error(`unsupported xpath step in test fixture: ${step}`);
      return { tag: match[1]?.toUpperCase() as string, idx: Number(match[2]) };
    });
}

function resolveAbsoluteXPath(root: HappyDomElement, xp: string): HappyDomElement | null {
  let current: HappyDomElement | null = root;
  for (const step of parseXPathSteps(xp).slice(1)) {
    if (!current) return null;
    const candidates: HappyDomElement[] = Array.from(current.children).filter(
      (c: HappyDomElement) => c.tagName === step.tag
    );
    current = candidates[step.idx - 1] ?? null;
  }
  return current;
}

function resolveTailXPathAll(root: HappyDomElement, tailXp: string): HappyDomElement[] {
  const steps = parseXPathSteps(tailXp);
  const leafStep = steps[steps.length - 1];
  const parentStep = steps.length > 1 ? steps[steps.length - 2] : null;
  if (!leafStep) return [];
  const out: HappyDomElement[] = [];
  for (const el of Array.from(root.querySelectorAll("*")) as HappyDomElement[]) {
    if (el.tagName !== leafStep.tag) continue;
    const parent = el.parentElement as HappyDomElement | null;
    if (!parent) continue;
    const sameTag = Array.from(parent.children).filter(
      (c: HappyDomElement) => c.tagName === leafStep.tag
    );
    if (sameTag.indexOf(el) + 1 !== leafStep.idx) continue;
    if (parentStep) {
      if (parent.tagName !== parentStep.tag) continue;
      const grandparent = parent.parentElement as HappyDomElement | null;
      const parentIdx = grandparent
        ? Array.from(grandparent.children)
            .filter((c: HappyDomElement) => c.tagName === parentStep.tag)
            .indexOf(parent) + 1
        : 1;
      if (parentIdx !== parentStep.idx) continue;
    }
    out.push(el);
  }
  return out;
}

async function runScenario(
  innerHtml: string,
  targetSelector: string,
  instruction: string,
  staleXPath: string
): Promise<{ clicked: boolean; probes: ProbeResult[] }> {
  const window = new Window({ url: BASE_URL });
  const document = window.document;
  document.body.innerHTML = `<div class="page"><section><div>${innerHtml}</div></section></div>`;
  const target = document.querySelector(targetSelector) as unknown as HappyDomElement;
  if (!target) throw new Error("fixture setup failed");

  let clicked = false;
  (target as unknown as { addEventListener: (t: string, cb: () => void) => void }).addEventListener(
    "click",
    () => {
      clicked = true;
    }
  );

  const documentElement = document.documentElement as unknown as HappyDomElement;
  const win = window as unknown as { XPathResult?: unknown };
  win.XPathResult = { FIRST_ORDERED_NODE_TYPE: 9, ORDERED_NODE_SNAPSHOT_TYPE: 7 };
  (
    document as unknown as {
      evaluate: (e: string, c: unknown, n: unknown, t: number) => unknown;
    }
  ).evaluate = (expr: string, _ctx: unknown, _ns: unknown, type: number) => {
    if (expr.startsWith("//") && type === 7) {
      const matches = resolveTailXPathAll(documentElement, expr.slice(2));
      return { snapshotLength: matches.length, snapshotItem: (i: number) => matches[i] ?? null };
    }
    const node = expr.startsWith("//")
      ? (resolveTailXPathAll(documentElement, expr.slice(2))[0] ?? null)
      : resolveAbsoluteXPath(documentElement, expr);
    return { singleNodeValue: node };
  };

  const probes: ProbeResult[] = [];
  const session = { on: () => {}, off: () => {} };
  const page: Page = {
    evaluate: async (expr: unknown): Promise<unknown> => {
      const src = String(expr);
      const fn = new window.Function("document", "XPathResult", `return (${src});`) as (
        d: unknown,
        x: unknown
      ) => unknown;
      const result = fn(document, win.XPathResult);
      if (src.includes("fired:") && result && typeof result === "object") {
        probes.push(result as ProbeResult);
      }
      return result;
    },
    url: () => (clicked ? "https://apply.example.com/confirmed" : BASE_URL),
    title: async () => (clicked ? "Confirmed" : "Apply — Step 1"),
    locator: () => ({
      first: () => ({
        click: async () => {
          throw new Error("no node found for selector");
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

  const stagehand: Stagehand = {
    act: vi.fn().mockImplementation(async () => ({
      success: true,
      message: "clicked",
      actionDescription: "clicked",
      actions: [{ selector: `xpath=${staleXPath}`, description: "control", method: "click" }],
    })),
    observe: vi
      .fn()
      .mockImplementation(async (i?: unknown) =>
        typeof i === "string" ? [] : [{ selector: "xpath=//probe-presence", description: "p" }]
      ),
  } as unknown as Stagehand;

  const steps: HealingFlowStep[] = [
    { instruction, optional: false, upload: false, submitStep: false },
    { instruction: "Click the 'Details' link", optional: true, upload: false, submitStep: false },
  ];

  try {
    await runHealingFlow({
      stagehand,
      page,
      steps,
      logger: makeLogger(),
      anthropic: null,
      rephraseModel: null,
      uploadFixture: null,
    });
  } catch {
    // Verification outcome is irrelevant; only the click dispatch and probe result matter.
  }
  return { clicked, probes };
}

describe("flow-runner n+16 fallback — phrase-mismatched tail retarget", () => {
  it("refuses a tail-retargeted button naming none of the step's phrases and reports phraseMismatch", async () => {
    const { clicked, probes } = await runScenario(
      `<button type="button">Sign In</button>`,
      "button",
      CLICK_STEP,
      STALE_XPATH
    );
    expect(clicked).toBe(false);
    expect(probes.length).toBeGreaterThan(0);
    for (const p of probes) expect(p).toEqual({ fired: false, phraseMismatch: true });
  });

  it("still clicks a tail-retargeted button whose text matches a quoted phrase", async () => {
    const { clicked, probes } = await runScenario(
      `<button type="button">Create Account</button>`,
      "button",
      CLICK_STEP,
      STALE_XPATH
    );
    expect(clicked).toBe(true);
    expect(probes.some((p) => p.fired === true)).toBe(true);
    expect(probes.some((p) => p.phraseMismatch === true)).toBe(false);
  });

  it("leaves a fill step unaffected: the retargeted input is still resolved and fired", async () => {
    const { clicked, probes } = await runScenario(
      `<input type="text" aria-label="Unrelated" />`,
      "input",
      "Fill in the 'Email' field with 'jane@example.com'",
      "/html[1]/body[1]/div[1]/div[1]/div[1]/input[1]"
    );
    expect(clicked).toBe(true);
    expect(probes.some((p) => p.phraseMismatch === true)).toBe(false);
  });

  it("leaves a select step unaffected", async () => {
    const { clicked, probes } = await runScenario(
      `<button type="button">Unrelated</button>`,
      "button",
      "Select the option 'Engineering' for the 'Department' question",
      STALE_XPATH
    );
    expect(clicked).toBe(true);
    expect(probes.some((p) => p.phraseMismatch === true)).toBe(false);
  });

  it("leaves a radio step unaffected", async () => {
    const { clicked, probes } = await runScenario(
      `<button type="button">Unrelated</button>`,
      "button",
      "Click the 'Yes' answer for the question 'Are you at least 18 years old?'",
      STALE_XPATH
    );
    expect(clicked).toBe(true);
    expect(probes.some((p) => p.phraseMismatch === true)).toBe(false);
  });
});
