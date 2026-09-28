import type { ActResult, Page, Stagehand } from "@browserbasehq/stagehand";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { type HealingFlowStep, runHealingFlow } from "@/scraper/flow-runner";
import type { SubmitCandidate } from "@/scraper/submit-control";
import type { Logger } from "@/types/logging";

/**
 * Non-regression counterpart to the read-only-flow phantom-click coverage
 * (docs/recon-readonly-final-step-misclassified-as-submit.md): a flow that
 * genuinely declares submit semantics — here via a flow-level
 * `submitEndpointPattern` rather than a per-step `submitStep: true`, so the
 * flow-level derivation itself is exercised, not just the step flag — must
 * keep escalating a final-step phantom click straight to
 * `deep-submit-locator` and skipping `structured-click` /
 * `observe-act-exclude`. The fix narrows `submitShapedStep` from
 * `isFinalStep || submitStep` to require actual flow-level submit semantics;
 * this proves that narrowing doesn't also strip the escalation from flows
 * that DO have those semantics.
 */
describe("flow-runner/runHealingFlow — submit-flow phantom-click escalation stays intact", () => {
  const STEP = "Click the Submit button to submit the application form";

  function actResult(overrides: Partial<ActResult> = {}): ActResult {
    return {
      success: true,
      message: "clicked",
      actionDescription: "Click the Submit button",
      actions: [
        {
          selector: "button#submit",
          description: "Click the Submit button",
          method: "click",
        },
      ],
      ...overrides,
    };
  }

  function fakePage(params: {
    url: string;
    bodyHtmlLength: number;
    rankedCandidates?: SubmitCandidate[];
  }): { page: Page; evaluate: ReturnType<typeof vi.fn> } {
    const rankedCandidates = params.rankedCandidates ?? [
      { deepIndex: 7, tier: 3, tag: "button", accessibleName: "submit" },
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
      title: vi.fn().mockResolvedValue("Registered Nurse"),
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

  beforeEach(() => {
    infoMock.mockClear();
    warnMock.mockClear();
    errorMock.mockClear();
  });

  it("still escalates a final-step phantom click to deep-submit-locator, skipping structured-click/observe-act-exclude, when the flow declares submit semantics via submitEndpointPattern (not submitStep)", async () => {
    const { page } = fakePage({
      url: "https://apply.acme.example/jobs/1/apply-portal/apply",
      bodyHtmlLength: 184186,
    });
    const stagehandAct = vi.fn().mockResolvedValue(actResult());
    const stagehand = {
      act: stagehandAct,
      observe: vi
        .fn()
        .mockResolvedValue([
          { selector: "button#submit", description: "Click the Submit button", method: "click" },
        ]),
    } as unknown as Stagehand;

    const steps: HealingFlowStep[] = [
      { instruction: STEP, optional: false, upload: false, submitStep: false },
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
        // Flow-level submit signal: no submitStep on any step, but a
        // submitEndpointPattern is set — flowHasSubmitSemantics() must
        // treat this as a genuine submit flow.
        submitEndpointPattern: "/apply-portal/apply$",
        requireSubmitEndpointMatch: false,
      })
    ).rejects.toMatchObject({
      name: "StepVerificationError",
      kind: "phantom-click-exhausted",
    });

    // Attempt 1 (act-string) phantom-clicks; attempt 2 (deep-submit-locator)
    // also produces no observable effect (evaluate always answers
    // {clicked:false}) and attempts 3/4 (structured-click,
    // observe-act-exclude) are skipped by the submit-shaped short-circuit —
    // so stagehand.act is invoked exactly once, on attempt 1.
    expect(stagehandAct).toHaveBeenCalledTimes(1);

    const logged = [...infoMock.mock.calls, ...warnMock.mock.calls, ...errorMock.mock.calls]
      .map((call) => String(call[0]))
      .join("\n");
    expect(logged).toContain("deep-submit-locator");
    expect(logged).toContain("phantom click");
  });

  it("does not misroute a non-submit step's unresolved attempt 1 to trusted-click-retry — the normal ladder (observe-act) still runs", async () => {
    const { page } = fakePage({
      url: "https://portal.acme.example/dashboard/preferences",
      bodyHtmlLength: 42000,
    });
    // Attempt 1 resolves a target (a non-empty `actions[]`, so the cascade's
    // fast-skip for a totally-unresolved act() doesn't short-circuit before
    // classifyPhantomClick runs) but reports success:false — this is what
    // drives classifyPhantomClick's "unresolved" verdict
    // (actResultSuccess !== true), distinct from a phantom click
    // (success:true, zero effect).
    const stagehandAct = vi.fn().mockResolvedValue(
      actResult({
        success: false,
        actionDescription: "attempted toggle click",
        actions: [
          { selector: "#email-notifications-toggle", description: "toggle", method: "click" },
        ],
      })
    );
    // Non-empty so the pre-cascade presence probe (probeStepBeforeAttempts)
    // reports "present" and hands off to the cascade instead of short-
    // circuiting to a "probe-absent" replan — this test is about the
    // cascade's technique routing, not the probe.
    const stagehandObserve = vi
      .fn()
      .mockResolvedValue([
        {
          selector: "#email-notifications-toggle",
          description: "Email notifications switch",
          method: "click",
        },
      ]);
    const stagehand = {
      act: stagehandAct,
      observe: stagehandObserve,
    } as unknown as Stagehand;

    const steps: HealingFlowStep[] = [
      {
        instruction: "Toggle the 'Email notifications' switch",
        optional: false,
        upload: false,
        submitStep: false,
      },
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
      kind: "cascade-exhausted",
    });

    // trusted-click-retry needs attempt 1's resolved selector, which an
    // "unresolved" verdict never has — a non-submit step must fall through
    // to the ordinary ladder instead. Attempt 2 (observe-act) genuinely
    // running — not skipped, not rerouted — is what proves that: it calls
    // stagehand.observe(), which trusted-click-retry never would.
    expect(stagehandObserve).toHaveBeenCalled();

    const logged = [...infoMock.mock.calls, ...warnMock.mock.calls, ...errorMock.mock.calls]
      .map((call) => String(call[0]))
      .join("\n");
    expect(logged).toContain("no candidates resolved (unresolved verdict)");
    // The only "trusted-click-retry" mention allowed is the diagnostic that
    // explains WHY it was skipped (no resolved selector) — it must never be
    // dispatched as attempt 2's actual technique.
    expect(logged).toContain("no resolved target for trusted-click-retry");
    expect(logged).not.toContain("attempt 2 (trusted-click-retry)");
    expect(logged).not.toContain("deep-submit-locator");
  });
});
