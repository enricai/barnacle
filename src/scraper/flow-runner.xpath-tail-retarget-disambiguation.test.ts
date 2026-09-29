import type { Page, Stagehand } from "@browserbasehq/stagehand";
import type { Element as HappyDomElement } from "happy-dom";
import { Window } from "happy-dom";
import { describe, expect, it, vi } from "vitest";
import { type HealingFlowStep, runHealingFlow } from "@/scraper/flow-runner";
import type { Logger } from "@/types/logging";

/**
 * Pins bugfix-005: when `xpathTailForRetarget`'s loose `//`+tail pattern
 * (leaf + immediate-parent tag/position only, every other attribute
 * dropped) matches MORE than one live element, the n+16 fallback used to
 * accept whichever candidate `document.evaluate`'s `FIRST_ORDERED_NODE_TYPE`
 * happened to return first — document order, not plausibility order. This
 * fixture builds two independent containers that both resolve to the exact
 * same tail string ("div[1]/input[1]") — a decoy `<input type="button">`
 * ("Cancel"-shaped, non-submit) appearing FIRST in document order, and a
 * genuine `<input type="submit">` appearing second — and asserts the click
 * lands on the submit-shaped candidate, not the document-order-first decoy.
 */

const BASE_URL = "https://apply.example.com/step/1";
const STEP_INSTRUCTION = "Click the button to continue";

function makeLogger(): { logger: Logger; info: string[] } {
  const info: string[] = [];
  const logger = {
    info: vi.fn((msg: string) => info.push(msg)),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as unknown as Logger;
  return { logger, info };
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
  const steps = parseXPathSteps(xp);
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

/** Mirrors `xpathTailForRetarget`'s own loose leaf+parent tag/position match. */
function resolveTailXPathAll(root: HappyDomElement, tailXp: string): HappyDomElement[] {
  const steps = parseXPathSteps(tailXp);
  const leafStep = steps[steps.length - 1];
  const parentStep = steps.length > 1 ? steps[steps.length - 2] : null;
  if (!leafStep) return [];
  const all = Array.from(root.querySelectorAll("*")) as HappyDomElement[];
  const out: HappyDomElement[] = [];
  for (const el of all) {
    if (el.tagName !== leafStep.tag) continue;
    const parent = el.parentElement as HappyDomElement | null;
    if (!parent) continue;
    const sameTagSiblings = Array.from(parent.children).filter(
      (c: HappyDomElement) => c.tagName === leafStep.tag
    );
    if (sameTagSiblings.indexOf(el) + 1 !== leafStep.idx) continue;
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

describe("flow-runner n+16 fallback — xpath tail-retarget disambiguation on multiple matches", () => {
  it("prefers the submit-shaped candidate over the document-order-first decoy when the loose tail xpath matches two elements", async () => {
    const window = new Window({ url: BASE_URL });
    const document = window.document;
    document.body.innerHTML = `
      <div class="page">
        <section>
          <div><input type="button" value="Cancel" /></div>
        </section>
        <section>
          <div><input type="submit" value="Create Account" /></div>
        </section>
      </div>
    `;

    const decoyInput = document.querySelector(
      "section:nth-of-type(1) input"
    ) as unknown as HappyDomElement;
    const submitInput = document.querySelector(
      "section:nth-of-type(2) input"
    ) as unknown as HappyDomElement;
    if (!decoyInput || !submitInput) throw new Error("fixture setup failed");

    let decoyClicked = false;
    let submitClicked = false;
    (
      decoyInput as unknown as { addEventListener: (t: string, cb: () => void) => void }
    ).addEventListener("click", () => {
      decoyClicked = true;
    });
    (
      submitInput as unknown as { addEventListener: (t: string, cb: () => void) => void }
    ).addEventListener("click", () => {
      submitClicked = true;
    });

    const documentElement = document.documentElement as unknown as HappyDomElement;
    // A stale primary xpath whose last two steps ("div[1]/input[1]") are the
    // tail xpathTailForRetarget derives, but whose FULL absolute path never
    // resolves (an extra, nonexistent ancestor level) — forcing every
    // attempt through the tail-retarget branch, exactly like a re-render
    // that shifted an ancestor's positional index.
    const staleXPath = "/html[1]/body[1]/div[1]/div[1]/div[1]/input[1]";

    const win = window as unknown as { XPathResult?: unknown };
    win.XPathResult = { FIRST_ORDERED_NODE_TYPE: 9, ORDERED_NODE_SNAPSHOT_TYPE: 7 };
    (
      document as unknown as {
        evaluate: (
          expr: string,
          ctx: unknown,
          ns: unknown,
          type: number
        ) => {
          singleNodeValue?: unknown;
          snapshotLength?: number;
          snapshotItem?: (i: number) => unknown;
        };
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

    const session = { on: () => {}, off: () => {} };
    const page: Page = {
      evaluate: async (expr: unknown): Promise<unknown> => {
        const src = String(expr);
        const fn = new window.Function("document", "XPathResult", `return (${src});`) as (
          d: unknown,
          x: unknown
        ) => unknown;
        return fn(document, win.XPathResult);
      },
      url: () => (submitClicked ? "https://apply.example.com/confirmed" : BASE_URL),
      title: async () => (submitClicked ? "Confirmed" : "Apply — Step 1"),
      // A real Playwright `.locator(xpath)` only resolves the PRIMARY
      // (stale) xpath — it has no knowledge of the tail retarget — so the
      // trusted-click delivery attempt fails, falling through to the
      // synthetic `clickExpr` fallback under test.
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
        .mockImplementation(async (instruction?: unknown) =>
          typeof instruction === "string"
            ? []
            : [{ selector: "xpath=//probe-presence", description: "probe-presence" }]
        ),
    } as unknown as Stagehand;

    const steps: HealingFlowStep[] = [
      { instruction: STEP_INSTRUCTION, optional: false, upload: false, submitStep: false },
      { instruction: "Click the 'Details' link", optional: true, upload: false, submitStep: false },
    ];
    const { logger } = makeLogger();

    try {
      await runHealingFlow({
        stagehand,
        page,
        steps,
        logger,
        anthropic: null,
        rephraseModel: null,
        uploadFixture: null,
      });
    } catch {
      // The step may or may not verify depending on weak-signal scoring —
      // irrelevant here. What matters is WHICH element the fallback clicked.
    }

    expect(submitClicked).toBe(true);
    expect(decoyClicked).toBe(false);
  });

  it("clicks the single tail match unchanged when the loose tail xpath resolves to exactly one element", async () => {
    const window = new Window({ url: BASE_URL });
    const document = window.document;
    document.body.innerHTML = `
      <div class="page">
        <section>
          <div><input type="submit" value="Confirm Order" /></div>
        </section>
      </div>
    `;

    const submitInput = document.querySelector("section input") as unknown as HappyDomElement;
    if (!submitInput) throw new Error("fixture setup failed");

    let submitClicked = false;
    (
      submitInput as unknown as { addEventListener: (t: string, cb: () => void) => void }
    ).addEventListener("click", () => {
      submitClicked = true;
    });

    const documentElement = document.documentElement as unknown as HappyDomElement;
    const staleXPath = "/html[1]/body[1]/div[1]/div[1]/div[1]/input[1]";

    const win = window as unknown as { XPathResult?: unknown };
    win.XPathResult = { FIRST_ORDERED_NODE_TYPE: 9, ORDERED_NODE_SNAPSHOT_TYPE: 7 };
    (
      document as unknown as {
        evaluate: (
          expr: string,
          ctx: unknown,
          ns: unknown,
          type: number
        ) => {
          singleNodeValue?: unknown;
          snapshotLength?: number;
          snapshotItem?: (i: number) => unknown;
        };
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

    const session = { on: () => {}, off: () => {} };
    const page: Page = {
      evaluate: async (expr: unknown): Promise<unknown> => {
        const src = String(expr);
        const fn = new window.Function("document", "XPathResult", `return (${src});`) as (
          d: unknown,
          x: unknown
        ) => unknown;
        return fn(document, win.XPathResult);
      },
      url: () => (submitClicked ? "https://checkout.example.com/confirmed" : BASE_URL),
      title: async () => (submitClicked ? "Confirmed" : "Checkout — Step 1"),
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
        .mockImplementation(async (instruction?: unknown) =>
          typeof instruction === "string"
            ? []
            : [{ selector: "xpath=//probe-presence", description: "probe-presence" }]
        ),
    } as unknown as Stagehand;

    const steps: HealingFlowStep[] = [
      { instruction: STEP_INSTRUCTION, optional: false, upload: false, submitStep: false },
      { instruction: "Click the 'Details' link", optional: true, upload: false, submitStep: false },
    ];
    const { logger } = makeLogger();

    try {
      await runHealingFlow({
        stagehand,
        page,
        steps,
        logger,
        anthropic: null,
        rephraseModel: null,
        uploadFixture: null,
      });
    } catch {
      // Same caveat as above: verification outcome is irrelevant, only the click target matters.
    }

    expect(submitClicked).toBe(true);
  });
});
