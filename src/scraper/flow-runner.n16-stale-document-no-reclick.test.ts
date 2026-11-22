import type { Page, Stagehand } from "@browserbasehq/stagehand";
import type { Element as HappyDomElement } from "happy-dom";
import { Window } from "happy-dom";
import { describe, expect, it, vi } from "vitest";
import { extractTaggedPhrases } from "@/scraper/deep-locator-candidates";
import { type AttemptRecord, executeStepWithHealing } from "@/scraper/flow-runner";
import type { Logger } from "@/types/logging";

/**
 * When the act's click replaces the frame document (two-form flow whose pages
 * both show [Save as Draft] [Submit]), the n+16 fallback must not click again
 * on the new page; with an unchanged document it still fires. Generic fixture.
 */

const BASE_URL = "https://apply.example.com/login";
const STALE_XPATH = "/html[1]/body[1]/div[1]/div[1]/section[1]/button[2]";

function makeLogger(lines: string[]): Logger {
  return {
    info: vi.fn((m: string) => lines.push(m)),
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
      return { tag: (match[1] as string).toUpperCase(), idx: Number(match[2]) };
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

/** Mirrors `xpathTailForRetarget`'s loose leaf+parent tag/position match. */
function resolveTailXPathAll(root: HappyDomElement, tailXp: string): HappyDomElement[] {
  const steps = parseXPathSteps(tailXp);
  const leaf = steps[steps.length - 1];
  const parentStep = steps.length > 1 ? steps[steps.length - 2] : null;
  if (!leaf) return [];
  const out: HappyDomElement[] = [];
  for (const el of Array.from(root.querySelectorAll("*")) as HappyDomElement[]) {
    if (el.tagName !== leaf.tag) continue;
    const parent = el.parentElement as HappyDomElement | null;
    if (!parent) continue;
    const idx =
      Array.from(parent.children)
        .filter((c) => c.tagName === leaf.tag)
        .indexOf(el) + 1;
    if (idx !== leaf.idx) continue;
    if (parentStep) {
      if (parent.tagName !== parentStep.tag) continue;
      const gp = parent.parentElement as HappyDomElement | null;
      const pIdx = gp
        ? Array.from(gp.children)
            .filter((c) => c.tagName === parentStep.tag)
            .indexOf(parent) + 1
        : 1;
      if (pIdx !== parentStep.idx) continue;
    }
    out.push(el);
  }
  return out;
}

function buildHarness(
  submitLabel: string,
  opts: { replaceDocument?: boolean; replaceAfterReads?: number } = {}
) {
  let identityReads = 0;
  const window = new Window({ url: BASE_URL });
  const document = window.document;
  document.body.innerHTML = `
    <div class="page">
      <section><button type="button">Save as Draft</button><button type="button">${submitLabel}</button></section>
    </div>
  `;
  const buttons = Array.from(document.querySelectorAll("button")) as unknown as HappyDomElement[];
  let clicks = 0;
  let settles = 0;
  for (const button of buttons) {
    (
      button as unknown as { addEventListener: (t: string, cb: () => void) => void }
    ).addEventListener("click", () => {
      clicks += 1;
    });
  }
  const documentElement = document.documentElement as unknown as HappyDomElement;

  const win = window as unknown as { XPathResult?: unknown };
  win.XPathResult = { FIRST_ORDERED_NODE_TYPE: 9, ORDERED_NODE_SNAPSHOT_TYPE: 7 };
  (
    document as unknown as {
      evaluate: (e: string, c: unknown, n: unknown, t: number) => Record<string, unknown>;
    }
  ).evaluate = (expr: string, _c: unknown, _n: unknown, type: number) => {
    if (expr.startsWith("//") && type === 7) {
      const matches = resolveTailXPathAll(documentElement, expr.slice(2));
      return { snapshotLength: matches.length, snapshotItem: (i: number) => matches[i] ?? null };
    }
    const node = expr.startsWith("//")
      ? (resolveTailXPathAll(documentElement, expr.slice(2))[0] ?? null)
      : resolveAbsoluteXPath(documentElement, expr);
    return { singleNodeValue: node };
  };

  const session = { on: () => {}, off: () => {} };
  const page: Page = {
    evaluate: async (expr: unknown): Promise<unknown> => {
      if (opts.replaceDocument && expr === "performance.timeOrigin") {
        identityReads += 1;
        return identityReads <= (opts.replaceAfterReads ?? 0) ? 1000 : 1000 + identityReads;
      }
      const fn = new window.Function("document", "XPathResult", `return (${String(expr)});`) as (
        d: unknown,
        x: unknown
      ) => unknown;
      return fn(document, win.XPathResult);
    },
    url: () => BASE_URL,
    title: async () => "Sign in",
    locator: () => ({
      first: () => ({
        click: async () => {
          throw new Error("no node found for selector");
        },
        isChecked: async () => false,
        inputValue: async () => "",
      }),
    }),
    // Unrelated settling (non-zero html delta) on every wait.
    waitForTimeout: async () => {
      settles += 1;
      const p = document.createElement("p");
      p.textContent = `settling ${settles}`;
      document.body.appendChild(p);
    },
    getSessionForFrame: () => session,
    mainFrameId: () => "main",
    sendCDP: async () => ({ body: "{}", base64Encoded: false }),
  } as unknown as Page;

  const stagehand: Stagehand = {
    act: vi.fn().mockResolvedValue({
      success: true,
      message: "clicked",
      actionDescription: "clicked",
      actions: [{ selector: `xpath=${STALE_XPATH}`, description: "control", method: "click" }],
    }),
    observe: vi
      .fn()
      .mockImplementation(async (instruction?: unknown) =>
        typeof instruction === "string"
          ? []
          : [{ selector: "xpath=//probe-presence", description: "probe-presence" }]
      ),
  } as unknown as Stagehand;

  return { page, stagehand, getClicks: () => clicks };
}

function baseArgs(
  stagehand: Stagehand,
  page: Page,
  logger: Logger,
  step: string,
  onStepFailure: (a: { attempts: AttemptRecord[] }) => null
): never {
  return {
    stagehand,
    page,
    step,
    optional: false,
    upload: false,
    submitStep: true,
    flowHasSubmitSemantics: true,
    stepIndex: 0,
    totalSteps: () => 3,
    phase: "flow",
    signalCounter: { n: 0 },
    recentCaptures: [],
    recentCaptureMeta: [],
    anthropic: null,
    rephraseModel: null,
    logger,
    uploadFixture: null,
    isFinalStep: true,
    submitEndpointPattern: null,
    submittedStateSelectors: [],
    requireSubmitEndpointMatch: false,
    advanceTransitionBodyPattern: null,
    successUrlFragments: [],
    successPageTitleHints: [],
    ownBackendHostnames: [],
    knownErrorClassPrefixes: [],
    wizardExitButtonLabels: [],
    onStepFailure,
  } as never;
}

const STEP = "Click the 'Submit' button (not 'Save as Draft') to submit the form";

describe("flow-runner n+16 fallback — two-form stale document", () => {
  it("issues no click when the document identity changed since step start", async () => {
    const { page, stagehand, getClicks } = buildHarness("Submit", { replaceDocument: true });
    const lines: string[] = [];
    await executeStepWithHealing(
      baseArgs(stagehand, page, makeLogger(lines), STEP, () => null)
    ).catch(() => undefined);
    expect(lines.some((l) => l.includes("n+16 fallback skipped: frame document replaced"))).toBe(
      true
    );
    expect(getClicks()).toBe(0);
  });

  it("still fires the fallback click when the document is unchanged", async () => {
    const { page, stagehand, getClicks } = buildHarness("Submit");
    const lines: string[] = [];
    await executeStepWithHealing(
      baseArgs(stagehand, page, makeLogger(lines), STEP, () => null)
    ).catch(() => undefined);
    expect(lines.some((l) => l.includes("frame document replaced"))).toBe(false);
    expect(getClicks()).toBeGreaterThan(0);
  });
});
