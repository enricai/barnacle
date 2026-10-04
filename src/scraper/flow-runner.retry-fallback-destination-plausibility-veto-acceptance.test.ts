import type { Page, Stagehand } from "@browserbasehq/stagehand";
import type { Element as HappyDomElement } from "happy-dom";
import { Window } from "happy-dom";
import { describe, expect, it, vi } from "vitest";
import { type AttemptRecord, executeStepWithHealing } from "@/scraper/flow-runner";
import type { Logger } from "@/types/logging";

/**
 * Acceptance coverage for the n+16 synthetic `el.click()` fallback's own
 * `retryUrlChanged` (feeding `record.verifiedBy` and the `retryVerified`
 * gate at flow-runner.ts ~12565-12931): a genuine origin/path change alone
 * must not credit the fallback when the landed destination is sign-in-shaped
 * but the instructed step itself was not about signing in — the same
 * `isPlausibleStepDestination` gate the primary attempt loop's `urlChanged`
 * already applies. Distinct from
 * flow-runner.step-destination-plausibility-url-credit.test.ts's n+16 suite
 * (which mocks `guardedAct`/`guardedObserve` directly): this drives a real
 * `document.evaluate`-backed happy-dom page through a trusted-click `throw`,
 * mirroring flow-runner.trusted-click-throw-wrong-destination-veto-
 * acceptance.test.ts's trigger mechanism, so the fallback is reached only
 * after the primary attempt's trusted-click delivery is exhausted — not
 * driven straight into the fallback by a mock. `isFinalStep: false` and
 * `submitStep: false` isolate `retryVerified` down to `retryUrlChanged`
 * alone (no `retryDestinationUnconfirmed`/submit-endpoint-judge vetoes in
 * play), so a flip of this test depends on exactly the plausibility gate.
 * Site-agnostic fixture (generic "shop.example.com" checkout flow), not any
 * real site or plugin.
 */

const BASE_URL = "https://shop.example.com/checkout/shipping";
const CONTINUE_STEP = "Confirm the shipping address and continue to payment";

const INFO_LINES: string[] = [];
const testLogger = {
  info: vi.fn((m: string) => INFO_LINES.push(m)),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

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

describe("flow-runner n+16 fallback — retryUrlChanged bounces to a sign-in-shaped destination for a non-sign-in step (offline fixture, live happy-dom, no network)", () => {
  it("does not credit the fallback as verified when its genuine navigation lands on a sign-in-shaped path for a step that was never about signing in", async () => {
    const window = new Window({ url: BASE_URL });
    const document = window.document;
    document.body.innerHTML = `
      <div class="checkoutFooter">
        <a id="continueLink" href="/checkout/payment">Go to payment</a>
      </div>
    `;

    const continueEl = document.getElementById("continueLink") as unknown as HappyDomElement;
    expect(continueEl).not.toBeNull();
    const continueXPath = absoluteXPathFor(continueEl);

    let clickActivations = 0;
    let currentUrl = BASE_URL;
    let currentTitle = "Shipping";
    (
      continueEl as unknown as {
        addEventListener: (type: string, cb: (ev: unknown) => void) => void;
      }
    ).addEventListener("click", () => {
      clickActivations += 1;
      // A genuine origin/path change — the session bounced back to a
      // sign-in gate instead of actually advancing to payment.
      currentUrl = "https://shop.example.com/login";
      currentTitle = "Sign In";
    });

    const documentElement = document.documentElement as unknown as HappyDomElement;
    const win = window as unknown as { XPathResult?: unknown };
    win.XPathResult = { FIRST_ORDERED_NODE_TYPE: 9 };
    (document as unknown as { evaluate: (expr: string) => { singleNodeValue: unknown } }).evaluate =
      (expr: string) => {
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
      url: () => currentUrl,
      title: async () => currentTitle,
      // Forces attemptN16TrustedClick down its outer catch and into the
      // synthetic el.click() fallback — same precondition as
      // flow-runner.trusted-click-throw-wrong-destination-veto-acceptance.test.ts.
      locator: () => ({
        first: () => ({
          click: async () => {
            throw new Error("not actionable");
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
      act: vi.fn().mockResolvedValue({
        success: true,
        message: "clicked",
        actionDescription: CONTINUE_STEP,
        actions: [
          { selector: `xpath=${continueXPath}`, description: "Go to payment", method: "click" },
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

    const attemptsByFailure: AttemptRecord[][] = [];

    // `submitStep: true` makes `retrySubmitShaped` true unconditionally,
    // which excludes classifyPhantomClick's own (plausibility-unaware)
    // `effective`-verdict OR-branch from crediting the click on its raw
    // origin/path-change alone — and, since the resolved `<a>`'s accessible
    // name ("Go to payment") doesn't clear `SUBMIT_SHAPE_FALLBACK_EXPR`'s
    // generic-action-verb bar, `retryResolvedElementIsSubmitShaped` stays
    // false, so the submit-endpoint judge corroboration branch (which needs
    // `requireSubmitEndpoint || retryResolvedElementIsSubmitShaped ||
    // retryClickUsedXpathTailRetarget`, all false here) never engages
    // either. That isolates `retryVerified` down to `retryUrlChanged` alone
    // — the ONE signal `isPlausibleStepDestination` gates — so a flip of
    // this test depends on exactly the plausibility check under test.
    await expect(
      executeStepWithHealing({
        stagehand,
        page,
        step: CONTINUE_STEP,
        optional: false,
        upload: false,
        submitStep: true,
        flowHasSubmitSemantics: true,
        stepIndex: 0,
        totalSteps: () => 1,
        phase: "flow",
        signalCounter: { n: 0 },
        recentCaptures: [],
        recentCaptureMeta: [],
        anthropic: null,
        rephraseModel: null,
        logger: testLogger,
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
        onStepFailure: ({ attempts }: { attempts: AttemptRecord[] }) => {
          attemptsByFailure.push(attempts);
          return null;
        },
      } as never)
    ).rejects.toThrow(/verification|attempts/i);

    expect(clickActivations).toBeGreaterThan(0);
    expect(attemptsByFailure.length).toBeGreaterThan(0);
    expect((attemptsByFailure[0] ?? []).length).toBeGreaterThan(0);

    // The fallback's own navigation was genuine (origin/path changed) but
    // landed on a sign-in-shaped destination for a step that was never
    // about signing in — must not be silently credited verified via url on
    // ANY attempt.
    for (const attempt of attemptsByFailure[0] ?? []) {
      expect(attempt.verifiedBy).not.toBe("url");
    }
  });
});
