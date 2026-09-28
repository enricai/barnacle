import type { ActResult, Page, Stagehand } from "@browserbasehq/stagehand";
import { describe, expect, it, vi } from "vitest";

import { type HealingFlowStep, runHealingFlow } from "@/scraper/flow-runner";
import type { SubmitCandidate } from "@/scraper/submit-control";
import type { Logger } from "@/types/logging";

/**
 * Pins bugfix-002 (the `isSubmitIntentStep` text-inference classifier) at the
 * acceptance level for the shape the recon report's diagnostic bundle
 * actually observed: a step carrying NO explicit `submitStep: true` flag,
 * and NOT the flow's final step (a later, unrelated step follows it),
 * whose instruction text unambiguously names a submit click. Mirrors
 * flow-runner.unresolved-attempt1-deep-locator-escalation-acceptance.test.ts
 * but drops the explicit flag and the "only step in the flow" shape those
 * tests relied on — this proves the escalation fires from text inference
 * ALONE, not from `submitStep` or `isFinalStep`. Before bugfix-002, neither
 * flag was set, so `submitShapedStep` (and thus the unresolved-attempt-1
 * short-circuit) was false and attempt 2 fell through to observe-act — the
 * SAME light-DOM-only ladder that structurally cannot reach a target the
 * light-DOM resolver can't see. A domain unrelated to the original report:
 * a checkout "Confirm Purchase" control rendered inside a custom-element/
 * shadow-root design system, followed by an unrelated "Newsletter Signup"
 * step that the fake page has no candidate for (so it cleanly skips as
 * optional) — the second step exists purely so the target step is
 * structurally mid-flow, not the flow's last one.
 */
describe("flow-runner/runHealingFlow — unflagged mid-flow submit-intent step escalates unresolved attempt-1 to deep-submit-locator", () => {
  const SUBMIT_STEP = "Click the 'Confirm Purchase' button to submit the completed checkout";
  const TRAILING_STEP = "Click the 'Newsletter Signup' banner";
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

  it("escalates attempt 2 to deep-submit-locator on a mid-flow, unflagged submit-intent step whose attempt 1 act() resolves zero candidates", async () => {
    const rankedCandidates: SubmitCandidate[] = [
      { deepIndex: 12, tier: 3, tag: "button", accessibleName: "Confirm Purchase" },
    ];
    const { page, clicked } = fakePage(rankedCandidates);

    // Attempt 1: Stagehand's own act() reports failure — success: false —
    // the "unresolved" verdict. A single low-confidence action is included
    // so the cascade's unrelated attempt-1 fast-skip does not intercept
    // this attempt before `classifyPhantomClick` ever runs.
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
    const stagehandObserve = vi.fn().mockImplementation(async (instruction?: string) => {
      // Only the target step resolves a candidate on its pre-cascade probe —
      // TRAILING_STEP (both its focused and unfocused observe calls) returns
      // empty so it cleanly skips as optional, keeping the target step
      // structurally mid-flow without needing its own act() call.
      if (instruction === SUBMIT_STEP) {
        return [
          { selector: "button#confirm-purchase", description: "Confirm Purchase", method: "click" },
        ];
      }
      return [];
    });
    const stagehand = {
      act: stagehandAct,
      observe: stagehandObserve,
    } as unknown as Stagehand;

    const steps: HealingFlowStep[] = [
      // No `submitStep: true` — the escalation must come from
      // `isSubmitIntentStep`'s text inference alone.
      { instruction: SUBMIT_STEP, optional: false, upload: false, submitStep: false },
      // Not the flow's final step: a later, unrelated step follows it,
      // mirroring the report's step 17/58 shape. Optional + no probe
      // candidate so it skips cleanly without needing its own act() call.
      { instruction: TRAILING_STEP, optional: true, upload: false, submitStep: false },
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

    expect(result.submitStepSkipped).toBe(false);

    // Attempt 1 (act-string) resolves zero candidates; attempt 2
    // (deep-submit-locator) clicks the ranked top pick and the URL change
    // confirms the effect — so stagehand.act is invoked exactly once, on
    // attempt 1, and the deep-index click is invoked exactly once. The
    // trailing step calls neither act nor the deep locator, so these counts
    // are unaffected by it being present.
    expect(stagehandAct).toHaveBeenCalledTimes(1);
    expect(clicked.n).toBe(1);

    const logged = [...infoMock.mock.calls, ...warnMock.mock.calls, ...errorMock.mock.calls]
      .map((call) => String(call[0]))
      .join("\n");
    expect(logged).toContain("deep-submit-locator");
    expect(logged).toContain("skipped (optional, probe found no candidates)");
  });
});
