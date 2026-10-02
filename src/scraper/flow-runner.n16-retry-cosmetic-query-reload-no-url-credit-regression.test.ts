import type { Page, Stagehand } from "@browserbasehq/stagehand";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { type AttemptRecord, executeStepWithHealing } from "@/scraper/flow-runner";
import type { Logger } from "@/types/logging";

/**
 * Regression coverage for bugfix-002's `hasOriginOrPathChanged` fix applied
 * to the n+16 `el.click()` fallback's OWN pre/post url() pair (`retryUrlChanged
 * = hasOriginOrPathChanged(pre.url, retryPost.url)` in `flow-runner.ts`), a
 * distinct site from the primary attempt body the fix's other regression
 * coverage exercises. Attempt 1's act-string reports `actResultSuccess: true`
 * with no verified signal (same path, no network), so the cascade falls
 * through to the n+16 fallback. The fallback's own click then bounces the
 * page back to the identical origin+path with only a fresh transient query
 * param — the exact shape of a cache-busting reload, not a genuine
 * navigation.
 *
 * The step is marked `submitStep`/`isFinalStep` so `retrySubmitShaped` is
 * true, which excludes the fallback's OTHER (unrelated, pre-existing)
 * `classifyPhantomClick`-derived effective-verdict channel — that predicate
 * compares `post.url !== pre.url` directly rather than through
 * `hasOriginOrPathChanged` and would otherwise ALSO credit this same
 * cosmetic-query bounce via a different route, masking whether the
 * `retryUrlChanged` fix under test is actually what is (or isn't) gating
 * the credit. With every other fallback signal (network, checkbox state,
 * element-scoped selection state, the weak html/text/form-value OR-branch)
 * also absent by construction, `retryUrlChanged` is the ONLY channel left
 * that could credit this attempt — and with the fix in place it doesn't:
 * the cascade exhausts its attempts and rejects, and the attempt-1 record
 * the failure dump carries is never `verifiedBy: "url"`.
 */

const guardedAct = vi.fn();
const guardedObserve = vi.fn();

vi.mock("@/scraper/stagehand-guard", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/scraper/stagehand-guard")>();
  return {
    ...actual,
    guardedAct: (...args: unknown[]) => guardedAct(...args),
    guardedObserve: (...args: unknown[]) => guardedObserve(...args),
  };
});

const testLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

const BASE_URL = "https://apply.example.com/preview?session=abc";
const REVEAL_STEP = "Click the inline preview toggle to expand extra details";
const RESOLVED_XPATH_SELECTOR = "xpath=/html[1]/body[1]/div[1]/button[1]";

/**
 * Fake `Page` whose `evaluate()` recognizes ONLY the n+16 fallback's own
 * click-activation expression (unique among this cascade's evaluate() calls
 * for pairing `XPathResult.FIRST_ORDERED_NODE_TYPE` with a `kind: "click"`
 * return literal — see `clickExpr` in flow-runner.ts) and, on that call
 * alone, bounces `url()` to a same-path, cosmetic-query-only variant. Every
 * other evaluate() call (DOM snapshot, selection-state map, submit-shape
 * probe, xpath-tail-retarget probe, ng-invalid count, disabled-marker probe)
 * resolves `null`/absent, so none of those signals fire.
 */
function fakePage(urls: { current: string }): Page {
  const evaluate = vi.fn().mockImplementation(async (expr: unknown) => {
    const src = String(expr);
    if (src.includes("XPathResult.FIRST_ORDERED_NODE_TYPE") && src.includes('kind: "click"')) {
      // The n+16 fallback's own click fires and the page bounces back to
      // the identical origin+path with only a fresh transient query param.
      urls.current = "https://apply.example.com/preview?session=abc&clientRequestID=xyz-789";
      return { fired: true, kind: "click" };
    }
    return null;
  });

  return {
    evaluate,
    url: () => urls.current,
    title: vi.fn().mockResolvedValue("Preview"),
    locator: vi.fn().mockReturnValue({
      first: () => ({
        click: vi.fn().mockResolvedValue(undefined),
        isChecked: vi.fn().mockResolvedValue(false),
        inputValue: vi.fn().mockResolvedValue(""),
      }),
    }),
    waitForTimeout: vi.fn().mockResolvedValue(undefined),
  } as unknown as Page;
}

function makeStagehand(): Stagehand {
  return {} as unknown as Stagehand;
}

function baseParams(
  urls: { current: string },
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    stagehand: makeStagehand(),
    page: fakePage(urls),
    step: REVEAL_STEP,
    optional: false,
    upload: false,
    submitStep: true,
    stepIndex: 0,
    totalSteps: () => 1,
    isFinalStep: true,
    phase: "flow",
    signalCounter: { n: 0 },
    recentCaptures: [],
    recentCaptureMeta: [],
    anthropic: null,
    rephraseModel: null,
    logger: testLogger,
    uploadFixture: null,
    submitEndpointPattern: null,
    submittedStateSelectors: [],
    requireSubmitEndpointMatch: false,
    advanceTransitionBodyPattern: null,
    successUrlFragments: [],
    successPageTitleHints: [],
    ownBackendHostnames: [],
    knownErrorClassPrefixes: [],
    wizardExitButtonLabels: [],
    ...overrides,
  };
}

describe("flow-runner/executeStepWithHealing — n+16 fallback cosmetic same-path query reload is not credited verifiedBy=url", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Attempt 1's act-string: Stagehand resolves and "clicks" an xpath
    // selector (required for the n+16 fallback's `xpathBody()` gate to
    // admit this attempt) but the click lands with zero observable effect
    // at the primary-verifier level (no network, no url, no dom change) —
    // the act-string reports no verified signal, so the cascade falls
    // through to the n+16 fallback.
    guardedAct.mockResolvedValue({
      success: true,
      message: "clicked",
      actionDescription: "Preview toggle",
      actions: [
        { selector: RESOLVED_XPATH_SELECTOR, description: "Preview toggle", method: "click" },
      ],
    });
    // The pre-cascade presence probe (`probeStepBeforeAttempts`) calls
    // `guardedObserve(stagehand, step, ...)` first — must return a candidate
    // so the cascade is entered at all. No further candidates on retries —
    // if the fallback's cosmetic-query bounce is (correctly) not credited,
    // the cascade exhausts its attempts and rejects rather than silently
    // completing.
    guardedObserve.mockImplementation(async (_stagehand: unknown, instruction?: unknown) =>
      instruction === REVEAL_STEP
        ? [{ selector: RESOLVED_XPATH_SELECTOR, description: "Preview toggle", method: "click" }]
        : []
    );
  });

  it("a same-path, cosmetic-query-only reload from the n+16 fallback's own click is NOT credited verifiedBy=url", async () => {
    const urls = { current: BASE_URL };
    const attemptsByFailure: AttemptRecord[][] = [];

    await expect(
      executeStepWithHealing(
        baseParams(urls, {
          onStepFailure: ({ attempts }: { attempts: AttemptRecord[] }) => {
            attemptsByFailure.push(attempts);
            return null;
          },
        }) as never
      )
    ).rejects.toThrow(/verification|attempts|no candidates/i);

    expect(attemptsByFailure.length).toBeGreaterThan(0);
    const attempt1 = (attemptsByFailure[0] ?? []).find((a) => a.attempt === 1);
    expect(attempt1).toBeDefined();
    expect(attempt1?.verifiedBy).not.toBe("url");
  });
});
