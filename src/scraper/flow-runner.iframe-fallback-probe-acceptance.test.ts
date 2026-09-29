import type { ActResult, Page, Stagehand } from "@browserbasehq/stagehand";
import { describe, expect, it, vi } from "vitest";

import { type HealingFlowStep, runHealingFlow } from "@/scraper/flow-runner";
import type { SubmitCandidate } from "@/scraper/submit-control";
import type { Logger } from "@/types/logging";

/**
 * Acceptance coverage for bugfix-003's `probeChildFrameSubmitFallback`:
 * proves the single new branch it added to the cascade-exhaustion path
 * (flow-runner.ts, just above the terminal `throw new StepVerificationError`)
 * both recovers a same-origin-iframe-only submit control and leaves every
 * pre-existing (no-iframe) exhaustion case byte-for-byte unchanged. Mirrors
 * flow-runner.unresolved-submit-click-deep-locator-escalation-regression.test.ts's
 * harness shape (an `act()` that resolves one action but reports
 * `success: false`, so attempt 1 is "unresolved" and the cascade
 * short-circuits straight to exhaustion for a submit-shaped step) and adds a
 * `page.frames()` child-frame fake matching
 * flow-runner.deep-locator-scope-widening.test.ts's convention of routing a
 * `Frame.evaluate` call by matching a literal substring of the generated
 * expression.
 */
describe("flow-runner/runHealingFlow — same-origin child-iframe submit fallback (bugfix-003 acceptance)", () => {
  const STEP = "Click the 'Complete purchase' button to submit the checkout form";
  const PAGE_URL = "https://shop.example/checkout/review";
  const CHILD_FRAME_URL_BEFORE = "https://shop.example/embedded-widget";
  const CHILD_FRAME_URL_AFTER = "https://shop.example/embedded-widget/thank-you";

  function unresolvedActResult(): ActResult {
    return {
      success: false,
      message: "no candidates resolved",
      actionDescription: "Click the 'Complete purchase' button",
      actions: [
        {
          selector: "button#complete-purchase",
          description: "Click the 'Complete purchase' button",
          method: "click",
        },
      ],
    };
  }

  function unresolvedStagehand(): Stagehand {
    return {
      act: vi.fn().mockResolvedValue(unresolvedActResult()),
      observe: vi
        .fn()
        .mockResolvedValue([
          { selector: "button#complete-purchase", description: "Complete purchase", method: "click" },
        ]),
    } as unknown as Stagehand;
  }

  /** Distinguishes the two `buildRankSubmitCandidatesExpr` markers from the click-by-index marker, matching the sibling regression test's own convention. */
  function isRankExpr(src: string): boolean {
    return src.includes("ranked.sort");
  }
  function isClickExpr(src: string): boolean {
    return src.includes('__mouse("click"');
  }

  /**
   * Main-page fake whose own `evaluate` never surfaces a submit-shaped
   * candidate (rank always empty, click always `{clicked:false}`), so every
   * cascade attempt against the main frame fails and the run reaches the
   * bounded child-iframe fallback. `childFrame`, when supplied, backs
   * `page.frames()`; omitted models "no child frame attached at all" for
   * the regression case.
   */
  function fakePage(params: {
    childFrame?: { evaluate: ReturnType<typeof vi.fn> };
    /**
     * When set, `document.querySelector(frameSelector)` resolves as a
     * matched `<iframe>` with this `src` — an empty string routes
     * `tryResolveChildFrame` through its src-unreadable/identity-match
     * branch, which binds the sole `page.frames()` candidate SYNCHRONOUSLY
     * (no 100ms poll loop, no waiting out `frameReadyTimeoutMs`), matching
     * the declared-frameSelector test's need for a fast, deterministic
     * resolution.
     */
    declaredIframeSrc?: string;
  }): Page {
    const evaluate = vi.fn().mockImplementation(async (expr: unknown) => {
      const src = String(expr);
      if (src.includes('tagName !== "IFRAME"')) {
        return params.declaredIframeSrc !== undefined
          ? { matched: true, src: params.declaredIframeSrc }
          : { matched: false, src: null };
      }
      if (isRankExpr(src)) return [];
      if (isClickExpr(src)) return { clicked: false };
      if (src.includes("outerHTML")) return { html: 4096, text: "0:" };
      if (src.includes("isInvalid(el)")) return 0;
      return null;
    });
    return {
      evaluate,
      url: () => PAGE_URL,
      title: vi.fn().mockResolvedValue("Checkout"),
      locator: vi.fn().mockReturnValue({
        first: () => ({
          isChecked: vi.fn().mockResolvedValue(false),
          inputValue: vi.fn().mockResolvedValue(""),
        }),
      }),
      waitForTimeout: vi.fn().mockResolvedValue(undefined),
      getSessionForFrame: () => ({ on: () => {}, off: () => {} }),
      mainFrameId: () => "main",
      sendCDP: vi.fn().mockResolvedValue({ body: "{}", base64Encoded: false }),
      frames: () => (params.childFrame ? [params.childFrame] : []),
    } as unknown as Page;
  }

  /**
   * Same-origin child frame carrying exactly one submit-shaped candidate:
   * `location.href` starts at {@link CHILD_FRAME_URL_BEFORE} and advances to
   * {@link CHILD_FRAME_URL_AFTER} only once the click-by-index expression is
   * evaluated, giving `classifyPhantomClick`'s `urlChanged` signal a genuine
   * reason to fire and mark the click `effective` rather than `phantom`.
   */
  function makeRecoverableChildFrame() {
    const childUrl = { current: CHILD_FRAME_URL_BEFORE };
    const candidate: SubmitCandidate = {
      deepIndex: 2,
      tier: 3,
      tag: "button",
      accessibleName: "complete purchase",
    };
    const evaluate = vi.fn().mockImplementation(async (expr: unknown) => {
      if (expr === "location.href") return childUrl.current;
      const src = String(expr);
      if (isRankExpr(src)) return [candidate];
      if (isClickExpr(src)) {
        childUrl.current = CHILD_FRAME_URL_AFTER;
        return { clicked: true };
      }
      if (src.includes("outerHTML")) return { html: 4096, text: "0:" };
      return null;
    });
    return { evaluate, childUrl };
  }

  /** Same-origin child frame with no submit-shaped candidate at all — origin-probed but never clicked. */
  function makeEmptyChildFrame() {
    const evaluate = vi.fn().mockImplementation(async (expr: unknown) => {
      if (expr === "location.href") return CHILD_FRAME_URL_BEFORE;
      const src = String(expr);
      if (isRankExpr(src)) return [];
      return null;
    });
    return { evaluate };
  }

  function step(overrides: Partial<HealingFlowStep> = {}): HealingFlowStep {
    return {
      instruction: STEP,
      optional: false,
      upload: false,
      submitStep: true,
      ...overrides,
    };
  }

  function makeTestLogger(): Logger {
    return {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    } as unknown as Logger;
  }

  it("recovers via the same-origin child-iframe fallback when the main frame has no submit-shaped candidate but a child frame does", async () => {
    const childFrame = makeRecoverableChildFrame();
    const page = fakePage({ childFrame });
    const stagehand = unresolvedStagehand();
    const logger = makeTestLogger();

    const result = await runHealingFlow({
      stagehand,
      page,
      steps: [step()],
      logger,
      anthropic: null,
      rephraseModel: null,
      uploadFixture: null,
      // frameSelector omitted — the fallback only fires when the step never
      // declared its own frame scope.
    });

    expect(result).toMatchObject({ lastStepIndex: 0 });
    expect(childFrame.childUrl.current).toBe(CHILD_FRAME_URL_AFTER);
    const logged = [
      ...(logger.info as ReturnType<typeof vi.fn>).mock.calls,
      ...(logger.warn as ReturnType<typeof vi.fn>).mock.calls,
    ]
      .map((call) => String(call[0]))
      .join("\n");
    expect(logged).toContain(
      "cascade-exhausted: no candidate resolvable in the declared/main frame, but a same-origin child iframe surfaced a submit-shaped candidate"
    );
  });

  it("still throws cascade-exhausted, byte-for-byte as before, when no child frame is attached at all (no-iframe regression guard)", async () => {
    const page = fakePage({});
    const stagehand = unresolvedStagehand();
    const logger = makeTestLogger();

    await expect(
      runHealingFlow({
        stagehand,
        page,
        steps: [step()],
        logger,
        anthropic: null,
        rephraseModel: null,
        uploadFixture: null,
      })
    ).rejects.toMatchObject({
      name: "StepVerificationError",
      kind: "cascade-exhausted",
    });
  });

  it("still throws cascade-exhausted when a same-origin child frame is attached but surfaces no submit-shaped candidate", async () => {
    const childFrame = makeEmptyChildFrame();
    const page = fakePage({ childFrame });
    const stagehand = unresolvedStagehand();
    const logger = makeTestLogger();

    await expect(
      runHealingFlow({
        stagehand,
        page,
        steps: [step()],
        logger,
        anthropic: null,
        rephraseModel: null,
        uploadFixture: null,
      })
    ).rejects.toMatchObject({
      name: "StepVerificationError",
      kind: "cascade-exhausted",
    });

    const originProbes = childFrame.evaluate.mock.calls.filter(([expr]) => expr === "location.href");
    expect(originProbes.length).toBeGreaterThan(0);
  });

  it("never re-enumerates page.frames() for the bounded fallback when the step already declares a frameSelector that resolves", async () => {
    // A single attached child frame, identity-bound by `tryResolveChildFrame`'s
    // src-unreadable branch (empty `src` -> synchronous resolution, no
    // 100ms poll loop) so `frameTarget.declaredFrameSelector` is set BEFORE
    // the cascade ever runs. This same frame carries no submit-shaped
    // candidate, so if the bounded fallback's own `page.frames()` call were
    // (incorrectly) still reachable behind the guard, it would show up here
    // as extra `frames()` calls beyond resolution's own one.
    const childFrame = makeEmptyChildFrame();
    const page = fakePage({ childFrame, declaredIframeSrc: "" });
    const framesSpy = vi.spyOn(page, "frames");
    const stagehand = unresolvedStagehand();
    const logger = makeTestLogger();

    await expect(
      runHealingFlow({
        stagehand,
        page,
        steps: [step()],
        logger,
        anthropic: null,
        rephraseModel: null,
        uploadFixture: null,
        frameSelector: "iframe#embedded-widget",
      })
    ).rejects.toMatchObject({
      name: "StepVerificationError",
      kind: "cascade-exhausted",
    });

    // `tryResolveChildFrame`'s own identity-match resolution calls
    // `page.frames()` exactly once; the bounded fallback (gated off by
    // `frameTarget.declaredFrameSelector` being set) must add no further
    // calls on top of that.
    expect(framesSpy).toHaveBeenCalledTimes(1);
  });
});
