import type { ActResult, Page, Stagehand } from "@browserbasehq/stagehand";
import { describe, expect, it, vi } from "vitest";

import { type HealingFlowStep, runHealingFlow } from "@/scraper/flow-runner";
import type { SubmitCandidate } from "@/scraper/submit-control";
import type { Logger } from "@/types/logging";

/**
 * Pins bugfix-001 (fix(flow-runner): escalate unresolved attempt-1 verdicts to
 * deep-submit-locator) at the acceptance level, driven through `runHealingFlow`
 * exactly like flow-runner.submit-flow-phantom-click-regression.test.ts. Attempt
 * 1's `stagehand.act()` call returns `success: false` with zero resolved
 * selectors — `classifyPhantomClick`'s "unresolved" verdict (act() couldn't
 * resolve ANY candidate), distinct from the "phantom" verdict (act() resolved
 * and clicked something with zero effect) that already escalated before this
 * fix. Before bugfix-001, only "phantom" routed attempt 2 to deep-submit-locator
 * on a submit-shaped step, so an "unresolved" attempt 1 fell through to
 * observe-act/structured-click/observe-act-exclude — techniques that share the
 * SAME light-DOM resolution blind spot and would burn attempts 2-5 re-probing a
 * control the light-DOM resolver can't see (e.g. rendered inside a shadow root),
 * exactly the report's step-17 diagnostic bundle. A domain unrelated to the
 * original report: a checkout "Confirm Purchase" control rendered inside a
 * custom-element/shadow-root design system.
 */
describe("flow-runner/runHealingFlow — unresolved attempt-1 escalates straight to deep-submit-locator", () => {
  const STEP = "Click Confirm Purchase to complete checkout";
  const CHECKOUT_URL = "https://shop.example.com/checkout";
  const CONFIRMATION_URL = "https://shop.example.com/checkout/confirmation";

  function fakePage(rankedCandidates: SubmitCandidate[]): {
    page: Page;
    evaluate: ReturnType<typeof vi.fn>;
    clicked: { n: number };
  } {
    const clicked = { n: 0 };
    const evaluate = vi.fn().mockImplementation(async (expr: unknown) => {
      const src = String(expr);
      if (src.includes("ranked.sort")) return rankedCandidates;
      if (src.includes('__mouse("click"')) {
        clicked.n += 1;
        return { clicked: true };
      }
      if (src.includes("outerHTML")) return { html: 42000, text: "0:" };
      if (src.includes("isInvalid(el)")) return 0;
      return null;
    });
    const page = {
      evaluate,
      url: () => (clicked.n > 0 ? CONFIRMATION_URL : CHECKOUT_URL),
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
    } as unknown as Page;
    return { page, evaluate, clicked };
  }

  const infoMock = vi.fn();
  const warnMock = vi.fn();
  const errorMock = vi.fn();
  const testLogger = {
    info: infoMock,
    warn: warnMock,
    error: errorMock,
    debug: vi.fn(),
  } as unknown as Logger;

  it("escalates attempt 2 to deep-submit-locator and completes via the ranked deep-query candidate when attempt 1's act() resolves zero candidates", async () => {
    const rankedCandidates: SubmitCandidate[] = [
      { deepIndex: 12, tier: 3, tag: "button", accessibleName: "Confirm Purchase" },
    ];
    const { page, clicked } = fakePage(rankedCandidates);

    // Attempt 1: Stagehand's own act() reports failure — success: false —
    // the "unresolved" verdict (distinct from "phantom", where success is
    // true but the click has zero observable effect). A single low-confidence
    // action is included so the cascade's unrelated attempt-1 fast-skip
    // (executeStepWithHealing's `resolvedAction === null` shortcut, which
    // exists for a hard Stagehand throw / truly empty actions array) does not
    // intercept this attempt before `classifyPhantomClick` ever runs —
    // isolating the "unresolved" verdict this test targets from that
    // orthogonal fast-skip.
    const unresolvedResult: ActResult = {
      success: false,
      message: "no actionable element found",
      actionDescription: "could not resolve Confirm Purchase",
      actions: [
        {
          selector: "button#confirm-purchase",
          description: "could not resolve Confirm Purchase",
          method: "click",
        },
      ],
    };
    const stagehandAct = vi.fn().mockResolvedValue(unresolvedResult);
    const stagehand = {
      act: stagehandAct,
      // The pre-cascade page-state probe (probeStepBeforeAttempts) must see
      // a candidate so the step reaches attempt 1 rather than fast-skipping
      // as "probe-absent" — attempt 1's own act() is the one that then
      // resolves zero candidates.
      observe: vi
        .fn()
        .mockResolvedValue([
          { selector: "button#confirm-purchase", description: "Confirm Purchase", method: "click" },
        ]),
    } as unknown as Stagehand;

    const steps: HealingFlowStep[] = [
      { instruction: STEP, optional: false, upload: false, submitStep: true },
    ];

    const result = await runHealingFlow({
      stagehand,
      page,
      steps,
      logger: testLogger,
      anthropic: null,
      rephraseModel: null,
      uploadFixture: null,
    });

    expect(result.submitVerified).toBe(true);
    expect(result.submitStepSkipped).toBe(false);

    // Attempt 1 (act-string) resolves zero candidates; attempt 2
    // (deep-submit-locator) clicks the ranked top pick and the URL change
    // confirms the effect — so stagehand.act is invoked exactly once, on
    // attempt 1, and the deep-index click is invoked exactly once.
    expect(stagehandAct).toHaveBeenCalledTimes(1);
    expect(clicked.n).toBe(1);

    const logged = [...infoMock.mock.calls, ...warnMock.mock.calls, ...errorMock.mock.calls]
      .map((call) => String(call[0]))
      .join("\n");
    expect(logged).toContain("deep-submit-locator");
  });
});
