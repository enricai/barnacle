import type { ActResult, Page, Stagehand } from "@browserbasehq/stagehand";
import { describe, expect, it, vi } from "vitest";

import { type HealingFlowStep, runHealingFlow } from "@/scraper/flow-runner";
import type { SubmitCandidate } from "@/scraper/submit-control";
import type { Logger } from "@/types/logging";

/**
 * Companion to flow-runner.submit-flow-phantom-click-regression.test.ts:
 * proves the escalation to `deep-submit-locator` also fires when attempt 1's
 * `classifyPhantomClick` verdict is "unresolved" (`actResultSuccess !== true`)
 * rather than "phantom" (act() reported success but the click no-op'd). Both
 * verdicts must route the submit-shaped short-circuit the same way —
 * "unresolved" is, if anything, stronger evidence of unreachability than
 * "phantom".
 *
 * Attempt 1 reports `success: false` while still returning one resolved
 * action/selector, rather than `actions: []`. `executeStepWithHealing` has a
 * separate fast-skip for attempt 1 resolving literally zero actions
 * (`resolvedAction === null`) that bypasses the pre/post snapshot —
 * `classifyPhantomClick` and the escalation state it feeds are never
 * computed on that path today, so escalation does not fire there; probed
 * directly (see investigation notes), that fast-skip path regresses four
 * other acceptance suites (flow-runner.oopif-dense-form-acceptance.test.ts,
 * flow-runner.replan-preserve-remaining-steps.test.ts) if made to escalate,
 * so this test targets the resolved-but-unsuccessful path the fix in
 * flow-runner.ts:9a1c415 actually covers.
 */
describe("flow-runner/runHealingFlow — unresolved submit-click escalates to deep-submit-locator", () => {
  const STEP = "Click the 'Place Order' button to submit the order";

  function unresolvedActResult(): ActResult {
    return {
      success: false,
      message: "no candidates resolved",
      actionDescription: "Click the 'Place Order' button",
      actions: [
        {
          selector: "button#place-order",
          description: "Click the 'Place Order' button",
          method: "click",
        },
      ],
    };
  }

  function fakePage(params: {
    url: string;
    bodyHtmlLength: number;
    rankedCandidates?: SubmitCandidate[];
  }): { page: Page; evaluate: ReturnType<typeof vi.fn> } {
    const rankedCandidates = params.rankedCandidates ?? [
      { deepIndex: 4, tier: 3, tag: "button", accessibleName: "place order" },
    ];
    const evaluate = vi.fn().mockImplementation(async (expr: unknown) => {
      const src = String(expr);
      if (src.includes("ranked.sort")) return rankedCandidates;
      if (src.includes('__mouse("click"')) return { clicked: false };
      if (src.includes("outerHTML")) return { html: params.bodyHtmlLength, text: "0:" };
      if (src.includes("isInvalid(el)")) return 0;
      return null;
    });
    const page = {
      evaluate,
      url: () => params.url,
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
    return { page, evaluate };
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

  it("escalates a final-step unresolved (zero-candidate) attempt-1 click to deep-submit-locator, skipping structured-click/observe-act-exclude", async () => {
    const { page } = fakePage({
      url: "https://shop.example/checkout/review",
      bodyHtmlLength: 92044,
    });
    const stagehandAct = vi.fn().mockResolvedValue(unresolvedActResult());
    const stagehand = {
      act: stagehandAct,
      observe: vi
        .fn()
        .mockResolvedValue([
          { selector: "button#place-order", description: "Click Place Order", method: "click" },
        ]),
    } as unknown as Stagehand;

    const steps: HealingFlowStep[] = [
      { instruction: STEP, optional: false, upload: false, submitStep: true },
    ];

    await expect(
      runHealingFlow({
        stagehand,
        page,
        steps,
        logger: testLogger,
        anthropic: null,
        rephraseModel: null,
        uploadFixture: null,
      })
    ).rejects.toMatchObject({
      name: "StepVerificationError",
      // "unresolved" only sets `phantomClickAfterAttempt1` when the verdict
      // is "phantom" — an "unresolved" attempt 1 exhausts the cascade under
      // the "cascade-exhausted" kind instead. The escalation to
      // deep-submit-locator (asserted below via the act() call count and
      // logs) is unaffected either way.
      kind: "cascade-exhausted",
    });

    // Attempt 1 (act-string) resolves zero candidates ("unresolved" verdict);
    // attempt 2 (deep-submit-locator) also produces no observable effect
    // (evaluate always answers {clicked:false}) and attempts 3/4
    // (structured-click, observe-act-exclude) are skipped by the
    // submit-shaped short-circuit — so stagehand.act is invoked exactly
    // once, on attempt 1.
    expect(stagehandAct).toHaveBeenCalledTimes(1);

    const logged = [...infoMock.mock.calls, ...warnMock.mock.calls, ...errorMock.mock.calls]
      .map((call) => String(call[0]))
      .join("\n");
    expect(logged).toContain("no candidates resolved (unresolved verdict)");
    expect(logged).toContain("escalating attempt 2 to deep-submit-locator");
    expect(logged).toContain("attempt 3 (structured-click) skipped");
    expect(logged).toContain("attempt 4 (observe-act-exclude) skipped");
  });
});
