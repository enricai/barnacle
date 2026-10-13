import type { Page, Stagehand } from "@browserbasehq/stagehand";
import type { Element as HappyDomElement } from "happy-dom";
import { Window } from "happy-dom";
import { describe, expect, it, vi } from "vitest";
import { extractTaggedPhrases } from "@/scraper/deep-locator-candidates";
import { type AttemptRecord, executeStepWithHealing } from "@/scraper/flow-runner";
import type { Logger } from "@/types/logging";

/**
 * Regression coverage for the n+16 synthetic-click fallback's target identity:
 * a stale primary xpath whose loose tail matches a control that is NOT the one
 * the instruction quotes must be refused (`phraseMismatch`) rather than
 * clicked, and a refused/unfired click must never be credited as verified even
 * when the DOM moved for unrelated reasons. Generic "apply.example.com" fixture.
 */

const BASE_URL = "https://apply.example.com/login";
const STALE_XPATH = "/html[1]/body[1]/div[1]/div[1]/section[1]/button[1]";

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

function buildHarness(buttonLabel: string) {
  const window = new Window({ url: BASE_URL });
  const document = window.document;
  document.body.innerHTML = `
    <div class="page">
      <section><button type="button">${buttonLabel}</button></section>
    </div>
  `;
  const button = document.querySelector("button") as unknown as HappyDomElement;
  let clicks = 0;
  let settles = 0;
  (button as unknown as { addEventListener: (t: string, cb: () => void) => void }).addEventListener(
    "click",
    () => {
      clicks += 1;
    }
  );
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
    submitStep: false,
    flowHasSubmitSemantics: false,
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
    isFinalStep: false,
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

const MISMATCH_INSTRUCTIONS = [
  "under the text 'Don't have an account yet?', click the 'Create Account' button",
  "Click the 'Create Account' button to switch to the registration form",
];

describe("flow-runner n+16 fallback — tail-retarget phrase identity", () => {
  it.each(MISMATCH_INSTRUCTIONS)(
    "refuses a stale-xpath tail match whose text is not the quoted phrase and dispatches no click: %s",
    async (instruction) => {
      const { page, stagehand, getClicks } = buildHarness("Sign In");
      const lines: string[] = [];
      const attempts: AttemptRecord[][] = [];

      await expect(
        executeStepWithHealing(
          baseArgs(stagehand, page, makeLogger(lines), instruction, (a) => {
            attempts.push(a.attempts);
            return null;
          })
        )
      ).rejects.toThrow(/verification|attempts/i);

      expect(getClicks()).toBe(0);
      const probes = lines.filter((l) => l.includes("n+16 probe:"));
      expect(probes.length).toBeGreaterThan(0);
      for (const line of probes) {
        expect(line).toContain("fired=false");
        expect(line).toMatch(/htmlDelta=-?[1-9]\d*/);
        expect(line).toContain("verified=false");
      }
      for (const attempt of attempts[0] ?? []) {
        expect(attempt.verifiedBy).not.toBe("dom");
      }
    }
  );

  it("still clicks the tail match when its text names the quoted phrase", async () => {
    const { page, stagehand, getClicks } = buildHarness("Create Account");
    const lines: string[] = [];

    await executeStepWithHealing(
      baseArgs(
        stagehand,
        page,
        makeLogger(lines),
        "Click the 'Create Account' button to switch to the registration form",
        () => null
      )
    ).catch(() => undefined);

    expect(getClicks()).toBeGreaterThan(0);
  });

  it("does not restrict radio steps, whose quoted text is an option rather than the control's own text", async () => {
    const { page, stagehand, getClicks } = buildHarness("Sign In");

    await executeStepWithHealing(
      baseArgs(
        stagehand,
        page,
        makeLogger([]),
        "Click the 'Yes' answer for the question 'Are you at least 18 years old?'",
        () => null
      )
    ).catch(() => undefined);

    expect(getClicks()).toBeGreaterThan(0);
  });
});

describe("extractTaggedPhrases — apostrophes inside quoted phrases", () => {
  it.each([
    [MISMATCH_INSTRUCTIONS[0] as string, ["Don't have an account yet?", "Create Account"]],
    [MISMATCH_INSTRUCTIONS[1] as string, ["Create Account"]],
  ])("extracts whole phrases from: %s", (instruction, expected) => {
    expect(extractTaggedPhrases(instruction).map((p) => p.text)).toEqual(expected);
  });
});
