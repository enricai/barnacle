import type { ActResult, Page, Stagehand } from "@browserbasehq/stagehand";
import { describe, expect, it, vi } from "vitest";

import { type HealingFlowStep, runHealingFlow } from "@/scraper/flow-runner";
import type { SubmitCandidate } from "@/scraper/submit-control";
import type { Logger } from "@/types/logging";

/**
 * Pins the submit-shaped predicate/ranking widening at the acceptance level,
 * mirroring flow-runner.unresolved-attempt1-deep-locator-escalation-acceptance.test.ts's
 * harness shape. Attempt 1's `stagehand.act()` reports `success: false` with
 * zero resolved selectors (`triedSelectors: []`) — the same "unresolved"
 * verdict that already escalates a submit-shaped step straight to
 * deep-submit-locator. What this test isolates is the step AFTER escalation:
 * the deep-submit-locator ranking must find the target even though it is a
 * `type="button"` control with no submit wording and no cached xpath (e.g.
 * `<button type="button">Create Account</button>` on an account-creation
 * form) — the generic-action-verb tier that only the ranking/predicate
 * widening adds. A domain unrelated to any real site: a generic example
 * company's account-creation form.
 */
describe('flow-runner/runHealingFlow — generic type="button" action control resolves via widened deep-submit-locator ranking', () => {
  const STEP = "Click Create Account to finish signing up";
  const SIGNUP_URL = "https://accounts.example.com/signup";
  const WELCOME_URL = "https://accounts.example.com/welcome";

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
      url: () => (clicked.n > 0 ? WELCOME_URL : SIGNUP_URL),
      title: vi.fn().mockResolvedValue("Create your account"),
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

  it("escalates to deep-submit-locator and completes via the ranked generic-action-button candidate when attempt 1's act() resolves zero candidates", async () => {
    const rankedCandidates: SubmitCandidate[] = [
      { deepIndex: 7, tier: 0.5, tag: "button", accessibleName: "create account" },
    ];
    const { page, clicked } = fakePage(rankedCandidates);

    // Attempt 1: Stagehand's own act() reports failure with zero resolved
    // selectors — mirrors the report's diagnostic bundle (actResultSuccess:
    // false, triedSelectors: []). A single low-confidence action is included
    // so the cascade's unrelated attempt-1 fast-skip (executeStepWithHealing's
    // `resolvedAction === null` shortcut) does not intercept this attempt
    // before the submit-shaped escalation ever runs.
    const unresolvedResult: ActResult = {
      success: false,
      message: "no actionable element found",
      actionDescription: "could not resolve Create Account",
      actions: [
        {
          selector: "button#create-account",
          description: "could not resolve Create Account",
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
          { selector: "button#create-account", description: "Create Account", method: "click" },
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
    // (deep-submit-locator) clicks the ranked top pick — the tier-0.5
    // generic-action-button candidate, since no stronger submit-worded
    // candidate exists on the page — and the URL change confirms the
    // effect, so stagehand.act is invoked exactly once and the deep-index
    // click is invoked exactly once, never exhausting the remaining
    // cascade techniques into a replan.
    expect(stagehandAct).toHaveBeenCalledTimes(1);
    expect(clicked.n).toBe(1);

    const logged = [...infoMock.mock.calls, ...warnMock.mock.calls, ...errorMock.mock.calls]
      .map((call) => String(call[0]))
      .join("\n");
    expect(logged).toContain("deep-submit-locator");
  });
});
