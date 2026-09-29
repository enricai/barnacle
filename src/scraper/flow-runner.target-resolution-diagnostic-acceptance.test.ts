import type { ActResult, Page, Stagehand } from "@browserbasehq/stagehand";
import { describe, expect, it, vi } from "vitest";

import { executeStepWithHealing } from "@/scraper/flow-runner";
import { mainFrameTarget } from "@/scraper/frame-target";
import type { Logger } from "@/types/logging";

const testLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

/** Submit-intent phrase (see `isSubmitIntentStep`'s `SUBMIT_INTENT_STEP_PHRASES`) so the cascade treats this step as submit-shaped and the diagnostic snapshot capture gate opens. */
const STEP = "Click the submit button to finish the application";

/** Ranked submit-shaped candidate the fake page's `buildRankSubmitCandidatesExpr` evaluate answers with — resolved but never actually clickable, matching the report's own step-failures/016 evidence shape (a candidate that WAS found but couldn't be committed). */
const RANKED_CANDIDATE = { deepIndex: 0, tier: 3, tag: "button", accessibleName: "Submit" };

/**
 * Fake `Stagehand` whose every resolution technique fails to find or commit
 * a target: `act()` always reports failure (drives attempt-1 act-string AND
 * attempt-5 llm-rephrase's own act call to "unresolved"), `observe()` always
 * returns zero candidates for a focused (instruction-scoped) call — driving
 * attempt-2/4's observe-act / observe-act-exclude to fail — while an
 * unfocused (instruction-less) call returns a stub "page has content"
 * candidate so `probeStepBeforeAttempts`'s reachability check hands off to
 * the cascade instead of short-circuiting straight to "probe-absent" before
 * a single technique ever runs.
 */
function fakeStagehand(): Stagehand {
  return {
    act: vi.fn().mockResolvedValue({
      success: false,
      message: "no-op",
      actionDescription: "",
      actions: [],
    } as ActResult),
    observe: vi
      .fn()
      .mockImplementation(async (instruction?: unknown) =>
        typeof instruction === "string"
          ? []
          : [{ selector: "xpath=//probe-presence", description: "probe-presence" }]
      ),
  } as unknown as Stagehand;
}

/**
 * Fake `Page` answering the two `evaluate` expressions
 * `captureTargetResolutionDiagnosticSnapshot` composes:
 * `buildRankSubmitCandidatesExpr` (identified by its unique `rankTier`
 * marker) returns `RANKED_CANDIDATE` so the snapshot's `candidates` list is
 * non-empty, and `buildCandidateDetailExpr` (identified by its
 * `deepElements[i]` detail-indexing marker) returns that candidate's
 * disabled/visible/role detail plus an accessibility excerpt. Every other
 * `evaluate` call (DOM snapshots, ng-invalid counts) is observational and
 * defaults to `null`/`0`, matching this file's sibling acceptance fixtures.
 */
function fakePage(): Page {
  return {
    url: () => "https://apply.example.org/onboarding/review",
    title: vi.fn().mockResolvedValue("Review | Onboarding"),
    evaluate: vi.fn().mockImplementation(async (expr: unknown) => {
      const src = String(expr);
      if (src.includes("document.body ? document.body.outerHTML : null")) {
        return "<body>onboarding review</body>";
      }
      if (src.includes("rankTier")) {
        return [RANKED_CANDIDATE];
      }
      if (src.includes("deepElements[i]")) {
        return {
          details: [{ role: "button", visible: true, disabled: true }],
          excerpt: "Submit your application",
        };
      }
      return null;
    }),
    locator: vi.fn(),
    waitForTimeout: vi.fn().mockResolvedValue(undefined),
  } as unknown as Page;
}

function baseParams(page: Page, stagehand: Stagehand) {
  return {
    stagehand,
    page,
    frameTarget: mainFrameTarget(page),
    step: STEP,
    optional: false,
    upload: false,
    submitStep: false,
    flowHasSubmitSemantics: true,
    stepIndex: 0,
    phase: "apply",
    signalCounter: { n: 0 },
    recentCaptures: [],
    recentCaptureMeta: [],
    anthropic: null,
    rephraseModel: null,
    logger: testLogger,
    captureFn: vi.fn().mockResolvedValue(undefined),
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
  };
}

describe("flow-runner/executeStepWithHealing — target-resolution diagnostic snapshot on full cascade exhaustion", () => {
  it("captures and threads a non-null diagnostic snapshot to the failure-persistence seam when every resolution technique fails to resolve a submit-shaped target", async () => {
    const page = fakePage();
    const stagehand = fakeStagehand();
    const onStepFailure = vi.fn().mockReturnValue("/tmp/dump.json");
    const params = { ...baseParams(page, stagehand), onStepFailure };

    await expect(executeStepWithHealing(params)).rejects.toMatchObject({
      name: "StepVerificationError",
    });

    // The cascade genuinely exhausted every technique — this is not a
    // probe-absent short-circuit. `act()` was invoked for attempt 1 at
    // minimum, and `observe()` was invoked with the focused instruction for
    // the observe-act techniques.
    expect((stagehand.act as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(0);
    const observeCalls = (stagehand.observe as ReturnType<typeof vi.fn>).mock.calls;
    expect(observeCalls.some((call) => call[0] === STEP)).toBe(true);

    // The failure-persistence seam received a non-null diagnostic snapshot —
    // proving the deliverable fires on genuine total cascade exhaustion of a
    // real (fake-driven) step run, not merely when the snapshot builder is
    // unit-tested in isolation against a hand-built input.
    expect(onStepFailure).toHaveBeenCalledTimes(1);
    const dump = onStepFailure.mock.calls[0]?.[0];
    expect(dump.targetResolutionDiagnostic).not.toBeNull();
    expect(dump.targetResolutionDiagnostic.candidates).toEqual([
      {
        tag: "button",
        accessibleName: "Submit",
        tier: 3,
        role: "button",
        visible: true,
        disabled: true,
      },
    ]);
    expect(dump.targetResolutionDiagnostic.accessibilityExcerpt).toBe("Submit your application");

    // Threaded into the thrown error via the seam's returned path, exactly
    // like the pre-existing bodyOuterHtml/finalObserve dump fields.
    const secondOnStepFailure = vi.fn().mockReturnValue("/tmp/dump.json");
    await expect(
      executeStepWithHealing({
        ...baseParams(fakePage(), fakeStagehand()),
        onStepFailure: secondOnStepFailure,
      })
    ).rejects.toThrow(/see \/tmp\/dump\.json/);
  });

  it("leaves the diagnostic snapshot null for a non-submit-shaped step even on full cascade exhaustion", async () => {
    const page = fakePage();
    const stagehand = fakeStagehand();
    const onStepFailure = vi.fn().mockReturnValue(null);
    const params = {
      ...baseParams(page, stagehand),
      step: "Click the 'Learn More' link",
      onStepFailure,
    };

    await expect(executeStepWithHealing(params)).rejects.toMatchObject({
      name: "StepVerificationError",
    });

    expect(onStepFailure).toHaveBeenCalledTimes(1);
    const dump = onStepFailure.mock.calls[0]?.[0];
    expect(dump.targetResolutionDiagnostic).toBeNull();
  });
});
