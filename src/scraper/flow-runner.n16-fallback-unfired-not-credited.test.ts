import type { Page, Stagehand } from "@browserbasehq/stagehand";
import type { Element as HappyDomElement } from "happy-dom";
import { Window } from "happy-dom";
import { describe, expect, it, vi } from "vitest";
import { type AttemptRecord, executeStepWithHealing } from "@/scraper/flow-runner";
import type { Logger } from "@/types/logging";

/**
 * Acceptance coverage for the n+16 synthetic `el.click()` fallback's `fired`
 * gating: when the fallback's probe finds nothing to click (`fired=false`),
 * a nonzero html/text DOM delta (here, unrelated settling from the previous
 * step) must not credit the step as verified through `weakDomSignalsAllowed`
 * or the effective-verdict disjunct. A control with `fired=true` and the same
 * kind of DOM delta must still be credited, guarding the legitimate
 * weak-signal path. `submitStep: false`, a non-final step, and a
 * non-submit-shaped element keep `weakDomSignalsAllowed` otherwise true.
 * Generic "apply.example.com" fixture.
 */

const BASE_URL = "https://apply.example.com/application/experience";
const CONTINUE_STEP = "Continue to the next section of the application";

function makeLogger(lines: string[]): Logger {
  return {
    info: vi.fn((m: string) => lines.push(m)),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as unknown as Logger;
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
    const idx = sameTag.indexOf(currentNode) + 1;
    steps.unshift(`${node.tagName.toLowerCase()}[${idx}]`);
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

function buildHarness(elementPresent: boolean) {
  const window = new Window({ url: BASE_URL });
  const document = window.document;
  document.body.innerHTML = `
    <div class="applicationFooter">
      <a id="continueLink" href="/application/education">Go to education</a>
    </div>
  `;

  const continueEl = document.getElementById("continueLink") as unknown as HappyDomElement;
  expect(continueEl).not.toBeNull();
  const continueXPath = absoluteXPathFor(continueEl);

  let clickActivations = 0;
  let settles = 0;
  const grow = (): void => {
    settles += 1;
    const p = document.createElement("p");
    p.textContent = `settling ${settles}`;
    document.body.appendChild(p);
  };
  (
    continueEl as unknown as {
      addEventListener: (type: string, cb: (ev: unknown) => void) => void;
    }
  ).addEventListener("click", () => {
    clickActivations += 1;
    grow();
  });
  if (!elementPresent) {
    // Target vanishes after Stagehand resolved it, so clickExpr yields {fired:false}.
    (continueEl as unknown as { remove: () => void }).remove();
  }

  const documentElement = document.documentElement as unknown as HappyDomElement;
  const win = window as unknown as { XPathResult?: unknown };
  win.XPathResult = { FIRST_ORDERED_NODE_TYPE: 9 };
  (document as unknown as { evaluate: (expr: string) => { singleNodeValue: unknown } }).evaluate = (
    expr: string
  ) => {
    const node = expr.startsWith("//") ? null : resolveAbsoluteXPath(documentElement, expr);
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
    url: () => BASE_URL,
    title: async () => "Experience",
    locator: () => ({
      first: () => ({
        click: async () => {
          throw new Error("not actionable");
        },
        isChecked: async () => false,
        inputValue: async () => "",
      }),
    }),
    waitForTimeout: async () => {
      if (!elementPresent) grow();
    },
    getSessionForFrame: () => session,
    mainFrameId: () => "main",
    sendCDP: async () => ({ body: "{}", base64Encoded: false }),
  } as unknown as Page;

  const stagehand: Stagehand = {
    act: vi.fn().mockResolvedValue({
      success: true,
      message: "clicked",
      actionDescription: CONTINUE_STEP,
      actions: [
        { selector: `xpath=${continueXPath}`, description: "Go to education", method: "click" },
      ],
    }),
    observe: vi
      .fn()
      .mockImplementation(async (instruction?: unknown) =>
        typeof instruction === "string"
          ? []
          : [{ selector: "xpath=//probe-presence", description: "probe-presence" }]
      ),
  } as unknown as Stagehand;

  return { page, stagehand, getClickActivations: () => clickActivations };
}

function baseArgs(
  stagehand: Stagehand,
  page: Page,
  logger: Logger,
  onStepFailure: (a: { attempts: AttemptRecord[] }) => null
): never {
  return {
    stagehand,
    page,
    step: CONTINUE_STEP,
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

describe("flow-runner n+16 fallback — fired gating of weak DOM-signal credit (offline fixture, live happy-dom, no network)", () => {
  it("does not credit the step when the fallback fired nothing (fired=false) despite a nonzero DOM delta", async () => {
    const { page, stagehand } = buildHarness(false);
    const infoLines: string[] = [];
    const logger = makeLogger(infoLines);
    const attemptsByFailure: AttemptRecord[][] = [];

    await expect(
      executeStepWithHealing(
        baseArgs(stagehand, page, logger, ({ attempts }) => {
          attemptsByFailure.push(attempts);
          return null;
        })
      )
    ).rejects.toThrow(/verification|attempts/i);

    const probes = infoLines.filter((l) => l.includes("n+16 probe:"));
    expect(probes.length).toBeGreaterThan(0);
    for (const line of probes) {
      expect(line).toContain("fired=false");
      expect(line).toMatch(/htmlDelta=-?[1-9]\d*/);
      expect(line).toContain("verified=false");
    }
    expect(attemptsByFailure.length).toBeGreaterThan(0);
    for (const attempt of attemptsByFailure[0] ?? []) {
      expect(attempt.verifiedBy).not.toBe("dom");
    }
  });

  it("still credits the step when the fallback fired (fired=true) with a nonzero DOM delta", async () => {
    const { page, stagehand, getClickActivations } = buildHarness(true);
    const infoLines: string[] = [];
    const logger = makeLogger(infoLines);

    const result = await executeStepWithHealing(baseArgs(stagehand, page, logger, () => null));

    expect(getClickActivations()).toBeGreaterThan(0);
    expect(result).toBeTruthy();
    const probes = infoLines.filter((l) => l.includes("n+16 probe:"));
    expect(probes.length).toBeGreaterThan(0);
    expect(probes[0]).toContain("fired=true");
    expect(probes[0]).toContain("verified=true");
  });
});
