import type { ActResult, Page, Stagehand } from "@browserbasehq/stagehand";
import { describe, expect, it, vi } from "vitest";

const { generateObjectMock } = vi.hoisted(() => ({ generateObjectMock: vi.fn() }));
vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return { ...actual, generateObject: generateObjectMock };
});

import {
  executeStepWithHealing,
  extractLivePageFormEvidence,
  flowHasSubmitSemantics,
  formatStepPrefix,
  type HealingFlowStep,
  parseRadioStep,
  parseSelectStep,
  pollEnumerate,
  prepareFailureDumpBody,
  runHealingFlow,
  selectionCountFromSignature,
  shouldCaptureSelectionState,
  waitForSpaReady,
  wireSignalCapture,
} from "@/scraper/flow-runner";
import { type FrameTarget, mainFrameTarget } from "@/scraper/frame-target";
import type { SubmitCandidate } from "@/scraper/submit-control";
import type { Capture } from "@/scripts/recon-shared";
import type { Logger } from "@/types/logging";

const testLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

/**
 * Fake page whose `evaluate` returns a scripted sequence of body lengths (one
 * per call) and whose `waitForTimeout` is a spy — so a test can assert the poll
 * loop's timing behavior without a real browser.
 */
function fakePage(bodyLengths: number[]): {
  page: Page;
  waitForTimeout: ReturnType<typeof vi.fn>;
} {
  let call = 0;
  const waitForTimeout = vi.fn().mockResolvedValue(undefined);
  const page = {
    evaluate: vi.fn().mockImplementation(async () => {
      const v = bodyLengths[Math.min(call, bodyLengths.length - 1)];
      call += 1;
      return v;
    }),
    waitForTimeout,
  } as unknown as Page;
  return { page, waitForTimeout };
}

describe("flow-runner/formatStepPrefix", () => {
  it("prints the bare form when no total getter is supplied", () => {
    expect(formatStepPrefix(4)).toBe("step 5");
  });

  it("prints the N/total form when a getter is supplied", () => {
    expect(formatStepPrefix(4, () => 338)).toBe("step 5/338");
  });

  it("re-reads the total on every call so a mid-run replan splice is reflected", () => {
    const plan = new Array(338).fill("step");
    const getter = (): number => plan.length;
    expect(formatStepPrefix(19, getter)).toBe("step 20/338");
    plan.splice(20, 0, "replanned");
    expect(formatStepPrefix(20, getter)).toBe("step 21/339");
  });
});

describe("flow-runner/selectionCountFromSignature", () => {
  const sig = (text: string): string => `${text.length}:${text}`;

  it("reads the running selected-count from a multi-select counter heading", () => {
    expect(selectionCountFromSignature(sig("Which options?\n0 settings selected\nWidget A"))).toBe(
      0
    );
    expect(selectionCountFromSignature(sig("Which options?\n2 settings selected\nWidget A"))).toBe(
      2
    );
  });

  it("returns null when no counter idiom is present", () => {
    expect(selectionCountFromSignature(sig("Pick your specialties"))).toBeNull();
  });

  it("tolerates a signature with no length prefix", () => {
    expect(selectionCountFromSignature("3 items selected")).toBe(3);
  });
});

describe("flow-runner/shouldCaptureSelectionState", () => {
  // This gate is the sole protection against #1 (submit false-credit) and #2
  // (advance regression): a false result leaves pre.selectionStateByXpath empty,
  // so verifyDomEffect's element read-back has no baseline and defers to
  // network/URL. It must be false for EVERY submit/final/advance step.
  it("captures for a plain selection/field-answer click step", () => {
    expect(
      shouldCaptureSelectionState({
        step: "Select 'Acute Care / Inpatient'",
        isFinalStep: false,
        submitStep: false,
        flowHasSubmitSemantics: true,
      })
    ).toBe(true);
  });

  it("does NOT capture for a submit step (self-toggling submit must not credit)", () => {
    expect(
      shouldCaptureSelectionState({
        step: "Click the 'Submit application' button",
        isFinalStep: false,
        submitStep: true,
        flowHasSubmitSemantics: true,
      })
    ).toBe(false);
  });

  it("does NOT capture for the final step", () => {
    expect(
      shouldCaptureSelectionState({
        step: "Confirm your selections",
        isFinalStep: true,
        submitStep: false,
        flowHasSubmitSemantics: true,
      })
    ).toBe(false);
  });

  it("captures the final step of a read-only flow with no submit semantics", () => {
    expect(
      shouldCaptureSelectionState({
        step: "Confirm your selections",
        isFinalStep: true,
        submitStep: false,
        flowHasSubmitSemantics: false,
      })
    ).toBe(true);
  });

  it("does NOT capture for an advance/Next step (no-pattern desync guard)", () => {
    expect(
      shouldCaptureSelectionState({
        step: "Click the Next button to continue",
        isFinalStep: false,
        submitStep: false,
        flowHasSubmitSemantics: true,
      })
    ).toBe(false);
  });

  it("still captures a selection step whose label merely contains 'next'/'continue' (not an advance phrase)", () => {
    expect(
      shouldCaptureSelectionState({
        step: "Select 'Next Available' shift preference",
        isFinalStep: false,
        submitStep: false,
        flowHasSubmitSemantics: true,
      })
    ).toBe(true);
    expect(
      shouldCaptureSelectionState({
        step: "Click the 'Continue Care' option",
        isFinalStep: false,
        submitStep: false,
        flowHasSubmitSemantics: true,
      })
    ).toBe(true);
  });
});

describe("flow-runner/flowHasSubmitSemantics", () => {
  it("returns false for a read-only flow (the royalcaribbean shape)", () => {
    expect(
      flowHasSubmitSemantics({
        steps: [{ submitStep: false }, { submitStep: false }, { submitStep: false }],
        submitEndpointPattern: null,
        requireSubmitEndpointMatch: false,
      })
    ).toBe(false);
  });

  it("returns true when any step is flagged submitStep: true", () => {
    expect(
      flowHasSubmitSemantics({
        steps: [{ submitStep: false }, { submitStep: true }],
        submitEndpointPattern: null,
        requireSubmitEndpointMatch: false,
      })
    ).toBe(true);
  });

  it("returns true when submitEndpointPattern is set, even with no submitStep", () => {
    expect(
      flowHasSubmitSemantics({
        steps: [{ submitStep: false }],
        submitEndpointPattern: "/api/apply$",
        requireSubmitEndpointMatch: false,
      })
    ).toBe(true);
  });

  it("returns true when requireSubmitEndpointMatch is true, even with no submitStep", () => {
    expect(
      flowHasSubmitSemantics({
        steps: [{ submitStep: false }],
        submitEndpointPattern: null,
        requireSubmitEndpointMatch: true,
      })
    ).toBe(true);
  });
});

describe("flow-runner/prepareFailureDumpBody", () => {
  it("elides a mega-attribute so rendered controls survive the length cap", () => {
    const blob = "x".repeat(120_000);
    const raw = `<div id="registration-app" data="${blob}"></div><button>Next</button>`;
    const out = prepareFailureDumpBody(raw);
    expect(out).not.toBeNull();
    expect(out).toContain("[elided 120000 chars]");
    expect(out).toContain("<button>Next</button>");
  });

  it("passes non-string input through as null", () => {
    expect(prepareFailureDumpBody(null)).toBeNull();
    expect(prepareFailureDumpBody(undefined)).toBeNull();
  });

  it("leaves ordinary bodies untouched below the attribute threshold", () => {
    const raw = `<button data-testid="ok">Go</button>`;
    expect(prepareFailureDumpBody(raw)).toBe(raw);
  });

  it("elides a double-quoted value that itself contains apostrophes", () => {
    const blob = "a'b'".repeat(30_000);
    const raw = `<div data="${blob}"></div><button>Next</button>`;
    const out = prepareFailureDumpBody(raw);
    expect(out).toContain("[elided");
    expect(out).toContain("<button>Next</button>");
  });
});

describe("flow-runner/waitForSpaReady", () => {
  it("returns immediately without polling when the body already exceeds the threshold", async () => {
    const { page, waitForTimeout } = fakePage([9000]);
    await waitForSpaReady(page, testLogger, { minBodyLength: 5000 });
    expect(waitForTimeout).not.toHaveBeenCalled();
  });

  it("polls until the SPA body grows past the threshold, then returns", async () => {
    const { page, waitForTimeout } = fakePage([100, 100, 8000]);
    await waitForSpaReady(page, testLogger, {
      minBodyLength: 5000,
      timeoutMs: 10_000,
      pollMs: 10,
    });
    expect(waitForTimeout).toHaveBeenCalledTimes(2);
  });

  it("proceeds (never throws) when the body stays below the threshold until timeout", async () => {
    const { page, waitForTimeout } = fakePage([100]);
    await expect(
      waitForSpaReady(page, testLogger, { minBodyLength: 5000, timeoutMs: 25, pollMs: 10 })
    ).resolves.toBeUndefined();
    expect(waitForTimeout.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it("treats a non-numeric evaluate result as zero and keeps waiting", async () => {
    let call = 0;
    const waitForTimeout = vi.fn().mockResolvedValue(undefined);
    const page = {
      evaluate: vi.fn().mockImplementation(async () => {
        call += 1;
        return call >= 2 ? 8000 : undefined;
      }),
      waitForTimeout,
    } as unknown as Page;
    await waitForSpaReady(page, testLogger, { minBodyLength: 5000, timeoutMs: 10_000, pollMs: 10 });
    expect(waitForTimeout).toHaveBeenCalledTimes(1);
  });

  it("resolves within its own budget (never hangs) when page.evaluate never settles", async () => {
    vi.useFakeTimers();
    try {
      const waitForTimeout = vi.fn().mockResolvedValue(undefined);
      const page = {
        // Every readBodyLength probe hangs forever — without a per-probe
        // watchdog this would pend waitForSpaReady indefinitely, since the
        // `while (Date.now() < deadline)` loop is never re-entered.
        evaluate: vi.fn().mockImplementation(() => new Promise(() => {})),
        waitForTimeout,
      } as unknown as Page;

      const resultPromise = waitForSpaReady(page, testLogger, {
        minBodyLength: 5000,
        timeoutMs: 1000,
        pollMs: 100,
      });
      const assertion = expect(resultPromise).resolves.toBeUndefined();

      // Advance well past the 1000ms budget (each poll iteration itself
      // costs one pollMs-bounded watchdog wait) so the deadline loop is
      // guaranteed to have exited by the time this assertion checks it.
      await vi.advanceTimersByTimeAsync(5000);
      await assertion;

      expect(testLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining("proceeding with possibly incomplete page")
      );
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("flow-runner/pollEnumerate", () => {
  it("evaluates against page when the target is the main frame", async () => {
    const { page } = fakePage([1]);
    const result = await pollEnumerate<number>(page, mainFrameTarget(page), "1", (n) => n > 0);
    expect(result).toBe(1);
    expect(page.evaluate).toHaveBeenCalledTimes(1);
  });

  it("evaluates against the resolved FrameTarget, not the main page", async () => {
    const { page } = fakePage([0]);
    const targetEvaluate = vi.fn().mockResolvedValue(1);
    const target = { evaluate: targetEvaluate } as unknown as FrameTarget;
    const result = await pollEnumerate<number>(page, target, "1", (n) => n > 0);
    expect(result).toBe(1);
    expect(targetEvaluate).toHaveBeenCalledTimes(1);
    expect(page.evaluate).not.toHaveBeenCalled();
  });

  it("retries the FrameTarget evaluate (not page.evaluate) while still using page.waitForTimeout for the delay", async () => {
    const { page, waitForTimeout } = fakePage([0]);
    let call = 0;
    const targetEvaluate = vi.fn().mockImplementation(async () => {
      call += 1;
      return call >= 2 ? 1 : 0;
    });
    const target = { evaluate: targetEvaluate } as unknown as FrameTarget;
    const result = await pollEnumerate<number>(page, target, "1", (n) => n > 0, {
      attempts: 3,
      intervalMs: 10,
    });
    expect(result).toBe(1);
    expect(targetEvaluate).toHaveBeenCalledTimes(2);
    expect(waitForTimeout).toHaveBeenCalledTimes(1);
    expect(page.evaluate).not.toHaveBeenCalled();
  });
});

/**
 * Fake CDP session that records the handlers `wireSignalCapture` registers so a
 * test can fire Network events in any order — the whole point, since
 * `responseReceivedExtraInfo` races `responseReceived`. `sendCDP` returns an
 * empty body so `onFinished` completes without a real browser.
 */
function fakeCapturePage(): {
  page: Page;
  emit: (event: string, params: unknown) => void | Promise<void>;
} {
  const handlers = new Map<string, (params: unknown) => void | Promise<void>>();
  const session = {
    on: (event: string, handler: (params: unknown) => void | Promise<void>) => {
      handlers.set(event, handler);
    },
    off: () => {},
  };
  const page = {
    getSessionForFrame: () => session,
    mainFrameId: () => "main",
    sendCDP: vi.fn().mockResolvedValue({ body: "{}", base64Encoded: false }),
  } as unknown as Page;
  const emit = (event: string, params: unknown): void | Promise<void> =>
    handlers.get(event)?.(params);
  return { page, emit };
}

describe("flow-runner/wireSignalCapture — Set-Cookie from responseReceivedExtraInfo", () => {
  const REQ = "req-1";
  const REQ_URL = "https://api.example.com/authz/private";

  /**
   * Drives a single request through wireSignalCapture, firing the given Network
   * events (requestWillBeSent and loadingFinished are added around them) and
   * returning the resulting capture. `events` is emitted in order, so a test
   * chooses whether extraInfo lands before or after responseReceived.
   */
  async function captureWith(events: Array<[string, unknown]>): Promise<Capture> {
    const { page, emit } = fakeCapturePage();
    const captured: Capture[] = [];
    const teardown = wireSignalCapture(page, {
      counter: { n: 0 },
      signalCounter: { n: 0 },
      recentCaptures: [],
      recentCaptureMeta: [],
      getCurrentPhase: () => "action",
      getCurrentPageOrigin: () => "https://api.example.com",
      onCapture: (capture) => captured.push(capture),
    });
    emit("Network.requestWillBeSent", {
      requestId: REQ,
      request: { url: REQ_URL, method: "POST", headers: {}, postData: "{}" },
    });
    for (const [event, params] of events) emit(event, params);
    await emit("Network.loadingFinished", { requestId: REQ });
    teardown();
    const cap = captured[0];
    if (!cap) throw new Error("no capture emitted");
    return cap;
  }

  const responseReceived: [string, unknown] = [
    "Network.responseReceived",
    { requestId: REQ, response: { status: 200, headers: { "content-type": "application/json" } } },
  ];
  const cookieExtraInfo: [string, unknown] = [
    "Network.responseReceivedExtraInfo",
    { requestId: REQ, headers: { "set-cookie": "__pa=SECRET; Path=/" } },
  ];

  it("captures set-cookie when extraInfo arrives AFTER responseReceived", async () => {
    const cap = await captureWith([responseReceived, cookieExtraInfo]);
    expect(cap.responseHeaders["set-cookie"]).toBe("__pa=SECRET; Path=/");
  });

  it("captures set-cookie when extraInfo arrives BEFORE responseReceived (the race)", async () => {
    const cap = await captureWith([cookieExtraInfo, responseReceived]);
    expect(cap.responseHeaders["set-cookie"]).toBe("__pa=SECRET; Path=/");
  });

  it("merges multiple extraInfo events for one requestId (redirect case)", async () => {
    const cap = await captureWith([
      [
        "Network.responseReceivedExtraInfo",
        { requestId: REQ, headers: { "set-cookie": "first=A" } },
      ],
      responseReceived,
      ["Network.responseReceivedExtraInfo", { requestId: REQ, headers: { "x-second": "B" } }],
    ]);
    expect(cap.responseHeaders["set-cookie"]).toBe("first=A");
    expect(cap.responseHeaders["x-second"]).toBe("B");
  });

  it("preserves responseReceived headers when no extraInfo fires", async () => {
    const cap = await captureWith([responseReceived]);
    expect(cap.responseHeaders["content-type"]).toBe("application/json");
    expect(cap.responseHeaders["set-cookie"]).toBeUndefined();
  });

  it("preserves the CDP newline separator across multiple Set-Cookie values", async () => {
    const cap = await captureWith([
      responseReceived,
      [
        "Network.responseReceivedExtraInfo",
        { requestId: REQ, headers: { "set-cookie": "a=1; Path=/\nb=2; Path=/" } },
      ],
    ]);
    expect(cap.responseHeaders["set-cookie"]).toBe("a=1; Path=/\nb=2; Path=/");
    expect(cap.responseHeaders["set-cookie"]).not.toContain(", ");
  });
});

describe("flow-runner/wireSignalCapture — Cookie from requestWillBeSentExtraInfo", () => {
  const REQ = "req-2";
  const REQ_URL = "https://api.example.com/apply/submit";

  async function captureWith(events: Array<[string, unknown]>): Promise<Capture> {
    const { page, emit } = fakeCapturePage();
    const captured: Capture[] = [];
    const teardown = wireSignalCapture(page, {
      counter: { n: 0 },
      signalCounter: { n: 0 },
      recentCaptures: [],
      recentCaptureMeta: [],
      getCurrentPhase: () => "action",
      getCurrentPageOrigin: () => "https://api.example.com",
      onCapture: (capture) => captured.push(capture),
    });
    for (const [event, params] of events) emit(event, params);
    await emit("Network.loadingFinished", { requestId: REQ });
    teardown();
    const cap = captured[0];
    if (!cap) throw new Error("no capture emitted");
    return cap;
  }

  const requestWillBeSent: [string, unknown] = [
    "Network.requestWillBeSent",
    { requestId: REQ, request: { url: REQ_URL, method: "POST", headers: {}, postData: "{}" } },
  ];
  const cookieExtraInfo: [string, unknown] = [
    "Network.requestWillBeSentExtraInfo",
    { requestId: REQ, headers: { cookie: "a=1; b=2" } },
  ];

  it("captures the outgoing Cookie header when extraInfo arrives AFTER requestWillBeSent", async () => {
    const cap = await captureWith([requestWillBeSent, cookieExtraInfo]);
    expect(cap.requestHeaders.cookie).toBe("a=1; b=2");
  });

  it("captures the outgoing Cookie header when extraInfo arrives BEFORE requestWillBeSent (the race)", async () => {
    const cap = await captureWith([cookieExtraInfo, requestWillBeSent]);
    expect(cap.requestHeaders.cookie).toBe("a=1; b=2");
  });

  it("merges multiple extraInfo events for one requestId (redirect case)", async () => {
    const cap = await captureWith([
      ["Network.requestWillBeSentExtraInfo", { requestId: REQ, headers: { cookie: "first=A" } }],
      requestWillBeSent,
      ["Network.requestWillBeSentExtraInfo", { requestId: REQ, headers: { "x-second": "B" } }],
    ]);
    expect(cap.requestHeaders.cookie).toBe("first=A");
    expect(cap.requestHeaders["x-second"]).toBe("B");
  });

  it("preserves requestWillBeSent headers when no extraInfo fires", async () => {
    const cap = await captureWith([requestWillBeSent]);
    expect(cap.requestHeaders.cookie).toBeUndefined();
  });
});

describe("flow-runner/executeStepWithHealing — phantom-click escalation", () => {
  const STEP = "Click the Submit button to submit the application form";

  /** Minimal ActResult envelope satisfying stagehand-guard's ACT_RESULT_SCHEMA. */
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

  /**
   * Fake page whose `evaluate` dispatches on the expression's shape rather
   * than an exact string match — flow-runner composes several distinct
   * page.evaluate expressions inline (DOM snapshot, ng-invalid count, submit
   * ranking, click-by-deep-index) and this harness has no seam to inject a
   * mock per callsite. `bodyHtmlLength` drives the DOM_SNAPSHOT_EXPR reply so
   * a test can control the pre/post delta the phantom classifier sees.
   */
  function fakePage(params: {
    url: string;
    bodyHtmlLength: number;
    deepIndexClicked?: number;
    /** Fires when the deep-locator's click-by-index expression hits the ranked candidate. */
    onDeepClick?: () => void;
    /** Overrides the ranked-candidates list; defaults to a single tier-3 "submit" button at deepIndex 7. */
    rankedCandidates?: SubmitCandidate[];
  }): {
    page: Page;
    evaluate: ReturnType<typeof vi.fn>;
  } {
    const { deepIndexClicked, onDeepClick } = params;
    const url = params.url;
    const rankedCandidates = params.rankedCandidates ?? [
      { deepIndex: 7, tier: 3, tag: "button", accessibleName: "submit" },
    ];
    const evaluate = vi.fn().mockImplementation(async (expr: unknown) => {
      const src = String(expr);
      if (src.includes("ranked.sort")) {
        return rankedCandidates;
      }
      if (src.includes('__mouse("click"')) {
        const requestedIndex = Number(src.match(/all\[(\d+)\]/)?.[1]);
        const clicked = requestedIndex === (deepIndexClicked ?? 7);
        if (clicked) onDeepClick?.();
        return { clicked };
      }
      if (src.includes("outerHTML")) {
        return { html: params.bodyHtmlLength, text: `0:` };
      }
      if (src.includes("isInvalid(el)")) {
        return 0;
      }
      return null;
    });
    const page = {
      evaluate,
      url: () => url,
      title: vi.fn().mockResolvedValue("Registered Nurse"),
      locator: vi.fn().mockReturnValue({
        first: () => ({
          isChecked: vi.fn().mockResolvedValue(false),
          inputValue: vi.fn().mockResolvedValue(""),
        }),
      }),
      waitForTimeout: vi.fn().mockResolvedValue(undefined),
    } as unknown as Page;
    return { page, evaluate };
  }

  function baseParams(page: Page, stagehandAct: ReturnType<typeof vi.fn>) {
    const stagehand = {
      act: stagehandAct,
      observe: vi
        .fn()
        .mockResolvedValue([
          { selector: "button#submit", description: "Click the Submit button", method: "click" },
        ]),
    } as unknown as Stagehand;
    return {
      stagehand,
      page,
      step: STEP,
      optional: false,
      upload: false,
      // Every test in this describe block exercises the deep-submit-locator
      // escalation, which now only fires on submit-shaped steps.
      submitStep: true,
      flowHasSubmitSemantics: true,
      stepIndex: 76,
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

  it("escalates to the deep submit-control locator when attempt 1 phantom-clicks (success reported, zero observable effect)", async () => {
    const signalCounter = { n: 0 };
    // Attempt 1 (act-string): Stagehand reports success but the click landed
    // on nothing — pre/post snapshot is byte-identical, matching the bug
    // report's attempt-1 shape. Attempt 2 (deep-submit-locator) clicks the
    // ranked candidate; its network effect (simulated via onDeepClick bumping
    // the shared counter) verifies the step.
    const { page, evaluate } = fakePage({
      url: "https://apply.acme.example/jobs/1/apply-portal/apply",
      bodyHtmlLength: 184186,
      onDeepClick: () => {
        signalCounter.n += 1;
      },
    });
    const stagehandAct = vi.fn().mockResolvedValue(actResult());
    const params = { ...baseParams(page, stagehandAct), signalCounter };

    const result = await executeStepWithHealing(params);

    expect(result).toBe("completed");
    // Stagehand's act (attempt 1) was invoked exactly once — attempts 2-4
    // (observe-act / structured-click / observe-act-exclude) never ran; the
    // cascade escalated straight to the deep locator instead of repeating
    // light-DOM techniques that would all no-op identically.
    expect(stagehandAct).toHaveBeenCalledTimes(1);
    const rankCalls = evaluate.mock.calls.filter(([expr]) => String(expr).includes("ranked.sort"));
    expect(rankCalls.length).toBe(1);
  });

  it("succeeds on attempt 1 via the existing path when the click is verified, with no deep-locator call", async () => {
    const { page, evaluate } = fakePage({
      url: "https://apply.acme.example/jobs/1/apply-portal/apply",
      bodyHtmlLength: 184186,
    });
    const signalCounter = { n: 0 };
    const stagehandAct = vi.fn().mockImplementation(async () => {
      // A real click's network request lands between the pre/post snapshot —
      // simulate it by bumping the shared counter the moment `act` resolves.
      signalCounter.n += 1;
      return actResult();
    });
    const params = { ...baseParams(page, stagehandAct), signalCounter };

    const result = await executeStepWithHealing(params);

    expect(result).toBe("completed");
    expect(stagehandAct).toHaveBeenCalledTimes(1);
    const rankCalls = evaluate.mock.calls.filter(([expr]) => String(expr).includes("ranked.sort"));
    expect(rankCalls.length).toBe(0);
    const clickByIndexCalls = evaluate.mock.calls.filter(([expr]) =>
      String(expr).includes('__mouse("click"')
    );
    expect(clickByIndexCalls.length).toBe(0);
  });

  it("aborts in strictly fewer than MAX_STEP_ATTEMPTS when the deep locator also phantom-clicks, throwing a phantom-click-specific kind", async () => {
    // Attempt 1 (act-string) phantom-clicks like the bug report. Attempt 2
    // (deep-submit-locator) finds a ranked candidate but its click never
    // lands (deepIndexClicked set to an index nothing requests) on EITHER
    // rank+click round — the one-shot re-rank retry (bugfix-003) also misses,
    // so it produces zero observable effect after exhausting its single
    // retry. shouldSkipTechnique then skips attempts 3-4 (structured-click /
    // observe-act-exclude — proven dead once phantomClickAfterAttempt1 is
    // set), leaving only attempt 5 (llm-rephrase, a no-op here since
    // `anthropic: null` short-circuits it before any LLM call). The cascade
    // exhausts in 3 recorded attempts (1, 2, 5) — strictly fewer than the
    // 5-attempt ceiling this replaces.
    const { page, evaluate } = fakePage({
      url: "https://apply.acme.example/jobs/1/apply-portal/apply",
      bodyHtmlLength: 184186,
      deepIndexClicked: -1,
    });
    const stagehandAct = vi.fn().mockResolvedValue(actResult());
    const params = { ...baseParams(page, stagehandAct), signalCounter: { n: 0 } };

    await expect(executeStepWithHealing(params)).rejects.toMatchObject({
      name: "StepVerificationError",
      kind: "phantom-click-exhausted",
    });
    // attempt 1 (act-string) + attempt 2 (deep-submit-locator); attempts 3-4
    // never ran (skipped by the phantom short-circuit), attempt 5
    // (llm-rephrase) short-circuits before touching stagehand.act — so
    // stagehand.act itself was only invoked once, on attempt 1.
    expect(stagehandAct).toHaveBeenCalledTimes(1);
    // Two rank+click rounds: the initial rank+click, then the one-shot
    // re-rank retry after the first click misses — both miss here, so the
    // retry is exhausted (not looped) and the attempt is recorded failed.
    const rankCalls = evaluate.mock.calls.filter(([expr]) => String(expr).includes("ranked.sort"));
    expect(rankCalls.length).toBe(2);
  });

  it("reaches rephraseWithLLM instead of the rephrase-skip path on a Bedrock-only config (anthropic: null, rephraseModel set)", async () => {
    // Same phantom-click shape as the previous test (attempt 1 phantom-clicks,
    // attempt 2's deep locator also phantom-clicks) so the cascade again lands
    // on attempt 5 (llm-rephrase). The only difference is `rephraseModel` is
    // a fake ai-SDK model instead of null — simulating a Bedrock-only
    // deployment (no ANTHROPIC_API_KEY, so `anthropic: null`, but
    // buildRephraseModel() still returns a Bedrock-backed model). Proves
    // attempt-5 rephrase runs on this config rather than hitting the
    // "no rephrase model configured; skipping rephrase" short-circuit.
    generateObjectMock.mockResolvedValueOnce({
      object: { instruction: "Click the alternate Submit control", outcome: "rewritten" },
      usage: { inputTokens: 10, outputTokens: 5 },
    });
    const fakeRephraseModel = { modelId: "bedrock-claude-fake" } as unknown as Parameters<
      typeof executeStepWithHealing
    >[0]["rephraseModel"];

    const { page } = fakePage({
      url: "https://apply.acme.example/jobs/1/apply-portal/apply",
      bodyHtmlLength: 184186,
      deepIndexClicked: -1,
    });
    const stagehandAct = vi.fn().mockResolvedValue(actResult());
    const params = {
      ...baseParams(page, stagehandAct),
      signalCounter: { n: 0 },
      anthropic: null,
      rephraseModel: fakeRephraseModel,
    };

    await expect(executeStepWithHealing(params)).rejects.toMatchObject({
      name: "StepVerificationError",
    });
    expect(generateObjectMock).toHaveBeenCalledTimes(1);
    expect(generateObjectMock).toHaveBeenCalledWith(
      expect.objectContaining({ model: fakeRephraseModel })
    );
    // attempt 5's rephrased instruction feeds a second stagehand.act call
    // (attempt 1 + the rephrase-driven retry).
    expect(stagehandAct).toHaveBeenCalledTimes(2);
  });

  it("records a ranked-empty deep-locator attempt and continues the cascade instead of throwing synchronously", async () => {
    // Attempt 1 (act-string) phantom-clicks like the bug report. Attempt 2
    // (deep-submit-locator) ranks zero submit-shaped candidates — the
    // ranking expression resolves to [] — so the branch records the
    // no-candidate error and falls through to the cascade's normal
    // continue/skip machinery (attempts 3-4 skipped by the phantom
    // short-circuit, attempt 5 llm-rephrase no-ops) rather than throwing
    // from inside the attempt-2 block itself.
    const evaluate = vi.fn().mockImplementation(async (expr: unknown) => {
      const src = String(expr);
      if (src.includes("ranked.sort")) return [];
      if (src.includes('__mouse("click"')) return { clicked: false };
      if (src.includes("outerHTML")) return { html: 184186, text: "0:" };
      if (src.includes("isInvalid(el)")) return 0;
      return null;
    });
    const page = {
      evaluate,
      url: () => "https://apply.acme.example/jobs/1/apply-portal/apply",
      title: vi.fn().mockResolvedValue("Registered Nurse"),
      locator: vi.fn().mockReturnValue({
        first: () => ({
          isChecked: vi.fn().mockResolvedValue(false),
          inputValue: vi.fn().mockResolvedValue(""),
        }),
      }),
      waitForTimeout: vi.fn().mockResolvedValue(undefined),
    } as unknown as Page;
    const stagehandAct = vi.fn().mockResolvedValue(actResult());
    const onStepFailure = vi.fn().mockReturnValue(null);
    const params = {
      ...baseParams(page, stagehandAct),
      signalCounter: { n: 0 },
      onStepFailure,
    };

    await expect(executeStepWithHealing(params)).rejects.toMatchObject({
      name: "StepVerificationError",
      kind: "phantom-click-exhausted",
    });

    expect(onStepFailure).toHaveBeenCalledTimes(1);
    const attempts = onStepFailure.mock.calls[0]?.[0].attempts;
    const deepLocatorAttempt = attempts.find(
      (a: { technique: string }) => a.technique === "deep-submit-locator"
    );
    expect(deepLocatorAttempt).toMatchObject({
      technique: "deep-submit-locator",
      errorMessage: "deep-submit-locator: no submit-shaped candidate found",
    });
  });

  it("records a stale-deepIndex click failure with actResultSuccess false after exhausting the one-shot re-rank retry, and does not crash the run", async () => {
    // Attempt 1 (act-string) phantom-clicks. Attempt 2 (deep-submit-locator)
    // ranks a candidate, but the click-by-index expression resolves
    // {clicked:false} on every round — the candidate vanishes before every
    // click lands (deepIndex is persistently stale, e.g. the page re-renders
    // on every tick). The branch retries the rank+click exactly once, then
    // must record actResultSuccess === false and a "candidate vanished"
    // errorMessage, and let the cascade continue rather than looping or
    // throwing here.
    const { page, evaluate } = fakePage({
      url: "https://apply.acme.example/jobs/1/apply-portal/apply",
      bodyHtmlLength: 184186,
      deepIndexClicked: -1,
    });
    const stagehandAct = vi.fn().mockResolvedValue(actResult());
    const onStepFailure = vi.fn().mockReturnValue(null);
    const params = {
      ...baseParams(page, stagehandAct),
      signalCounter: { n: 0 },
      onStepFailure,
    };

    await expect(executeStepWithHealing(params)).rejects.toMatchObject({
      name: "StepVerificationError",
      kind: "phantom-click-exhausted",
    });

    expect(onStepFailure).toHaveBeenCalledTimes(1);
    const attempts = onStepFailure.mock.calls[0]?.[0].attempts;
    const deepLocatorAttempt = attempts.find(
      (a: { technique: string }) => a.technique === "deep-submit-locator"
    );
    expect(deepLocatorAttempt.actResultSuccess).toBe(false);
    expect(deepLocatorAttempt.errorMessage).toMatch(/deepIndex stale/);
    // Bounded to exactly one retry (two rank+click rounds total) — a
    // persistently-stale page must not loop past this.
    const rankCalls = evaluate.mock.calls.filter(([expr]) => String(expr).includes("ranked.sort"));
    expect(rankCalls.length).toBe(2);
    const clickByIndexCalls = evaluate.mock.calls.filter(([expr]) =>
      String(expr).includes('__mouse("click"')
    );
    expect(clickByIndexCalls.length).toBe(2);
  });

  it("recovers from a one-time stale deepIndex by re-ranking once and clicking the fresh candidate", async () => {
    // Attempt 1 (act-string) phantom-clicks. Attempt 2 (deep-submit-locator)
    // ranks a candidate, but the FIRST click-by-index misses (deepIndex went
    // stale from a re-render between rank and click) while the SECOND
    // (post-re-rank) click lands successfully. This is the core recovery
    // this bugfix adds: a single transient stale-index miss must not fail
    // the attempt when a re-rank immediately clears it.
    const signalCounter = { n: 0 };
    let clickAttempts = 0;
    const evaluate = vi.fn().mockImplementation(async (expr: unknown) => {
      const src = String(expr);
      if (src.includes("ranked.sort")) {
        return [{ deepIndex: 7, tier: 3, tag: "button", accessibleName: "submit" }];
      }
      if (src.includes('__mouse("click"')) {
        clickAttempts += 1;
        const clicked = clickAttempts >= 2;
        if (clicked) signalCounter.n += 1;
        return { clicked };
      }
      if (src.includes("outerHTML")) {
        return { html: 184186, text: "0:" };
      }
      if (src.includes("isInvalid(el)")) {
        return 0;
      }
      return null;
    });
    const page = {
      evaluate,
      url: () => "https://apply.acme.example/jobs/1/apply-portal/apply",
      title: vi.fn().mockResolvedValue("Registered Nurse"),
      locator: vi.fn().mockReturnValue({
        first: () => ({
          isChecked: vi.fn().mockResolvedValue(false),
          inputValue: vi.fn().mockResolvedValue(""),
        }),
      }),
      waitForTimeout: vi.fn().mockResolvedValue(undefined),
    } as unknown as Page;
    const stagehandAct = vi.fn().mockResolvedValue(actResult());
    const params = { ...baseParams(page, stagehandAct), signalCounter };

    const result = await executeStepWithHealing(params);

    expect(result).toBe("completed");
    const rankCalls = evaluate.mock.calls.filter(([expr]) => String(expr).includes("ranked.sort"));
    expect(rankCalls.length).toBe(2);
    const clickByIndexCalls = evaluate.mock.calls.filter(([expr]) =>
      String(expr).includes('__mouse("click"')
    );
    expect(clickByIndexCalls.length).toBe(2);
  });

  it("retries the runner-up candidate within attempt 2 when the top-ranked deep click also phantoms", async () => {
    // Attempt 1 (act-string) phantom-clicks. Attempt 2 (deep-submit-locator)
    // ranks two candidates: the top pick (deepIndex 7) clicks successfully
    // but produces zero observable effect (a second phantom, distinct
    // web-component control) — so the branch retries ranked[1] (deepIndex
    // 12) WITHOUT consuming another cascade attempt slot. The runner-up's
    // click bumps the network signal, which verifies the step on attempt 2.
    const rankedCandidates: SubmitCandidate[] = [
      { deepIndex: 7, tier: 3, tag: "button", accessibleName: "submit" },
      { deepIndex: 12, tier: 1, tag: "div", accessibleName: "submit application" },
    ];
    const signalCounter = { n: 0 };
    const evaluate = vi.fn().mockImplementation(async (expr: unknown) => {
      const src = String(expr);
      if (src.includes("ranked.sort")) return rankedCandidates;
      if (src.includes('__mouse("click"')) {
        const requestedIndex = Number(src.match(/all\[(\d+)\]/)?.[1]);
        if (requestedIndex === 12) signalCounter.n += 1;
        return { clicked: requestedIndex === 7 || requestedIndex === 12 };
      }
      if (src.includes("outerHTML")) return { html: 184186, text: "0:" };
      if (src.includes("isInvalid(el)")) return 0;
      return null;
    });
    const page = {
      evaluate,
      url: () => "https://apply.acme.example/jobs/1/apply-portal/apply",
      title: vi.fn().mockResolvedValue("Registered Nurse"),
      locator: vi.fn().mockReturnValue({
        first: () => ({
          isChecked: vi.fn().mockResolvedValue(false),
          inputValue: vi.fn().mockResolvedValue(""),
        }),
      }),
      waitForTimeout: vi.fn().mockResolvedValue(undefined),
    } as unknown as Page;
    const stagehandAct = vi.fn().mockResolvedValue(actResult());
    const params = { ...baseParams(page, stagehandAct), signalCounter };

    const result = await executeStepWithHealing(params);

    expect(result).toBe("completed");
    // Only attempt 1 (act-string) invoked stagehand.act — the runner-up
    // retry happened inside attempt 2, so attempts 3-5 never ran.
    expect(stagehandAct).toHaveBeenCalledTimes(1);
    const clickByIndexCalls = evaluate.mock.calls
      .filter(([expr]) => String(expr).includes('__mouse("click"'))
      .map(([expr]) => Number(String(expr).match(/all\[(\d+)\]/)?.[1]));
    // Top pick (7) clicked first, then the runner-up (12) — both by
    // deep-index, extending the existing `deep-index:N` pseudo-selector
    // convention rather than a new format.
    expect(clickByIndexCalls).toEqual([7, 12]);
  });

  it("leaves the structured-click/observe-act-exclude ladder intact for a non-submit phantom click instead of routing to the deep-submit-locator", async () => {
    // Matches the bug report's step 38 (`Click the 'No' label for 'Are you
    // currently a Contingent Worker?'`): a non-submit radio-style step whose
    // attempt 1 phantom-clicks (Stagehand reports success, zero observable
    // effect). submitStep:false + isFinalStep:false means submitShapedStep
    // is false, so shouldSkipTechnique must NOT skip attempts 3/4 and attempt
    // 2 must run observe-act (calling stagehand.observe + stagehand.act
    // again) instead of the deep-submit-locator — proving the runner's
    // attempt-2 routing (not just the pure predicate) is scoped correctly.
    const { page, evaluate } = fakePage({
      url: "https://apply.acme.example/jobs/1/apply-portal/apply",
      bodyHtmlLength: 184186,
    });
    const stagehandAct = vi.fn().mockResolvedValue(actResult());
    const params = {
      ...baseParams(page, stagehandAct),
      step: "Click the 'No' label for 'Are you currently a Contingent Worker?'",
      optional: false,
      submitStep: false,
      isFinalStep: false,
      signalCounter: { n: 0 },
    };
    const stagehandObserve = (params.stagehand as unknown as { observe: ReturnType<typeof vi.fn> })
      .observe;

    await expect(executeStepWithHealing(params)).rejects.toMatchObject({
      name: "StepVerificationError",
    });

    // The deep-submit-locator's ranking expression must never be evaluated —
    // it ranks submit-shaped candidates only and would be a guaranteed no-op
    // on a radio control, so a non-submit phantom must never route there.
    const rankCalls = evaluate.mock.calls.filter(([expr]) => String(expr).includes("ranked.sort"));
    expect(rankCalls.length).toBe(0);
    // Attempt 1 (act-string) + attempt 2 (observe-act, NOT skipped) both call
    // stagehand.act — proving the cascade actually reached the light-DOM
    // fallback instead of short-circuiting to the submit-only locator.
    expect(stagehandAct.mock.calls.length).toBeGreaterThan(1);
    expect(stagehandObserve).toHaveBeenCalled();
  });

  it("leaves the structured-click/observe-act-exclude ladder intact for a read-only flow's final step instead of routing to the deep-submit-locator (regression: recon-readonly-final-step-misclassified-as-submit)", async () => {
    // Reproduces the exact reported misclassification: a read-only recon
    // flow (no submitStep anywhere, submitEndpointPattern:null,
    // requireSubmitEndpointMatch:false) whose LAST step happens to phantom-
    // click on attempt 1. Before the fix, `isFinalStep` alone inferred
    // submit-shape, so this final step was wrongly escalated straight to
    // deep-submit-locator and attempts 3/4 were skipped. With
    // flowHasSubmitSemantics:false, submitShapedStep must be false here too
    // — attempt 2 must run observe-act and attempts 3/4 must NOT be skipped.
    const { page, evaluate } = fakePage({
      url: "https://apply.acme.example/jobs/1/apply-portal/review",
      bodyHtmlLength: 184186,
    });
    const stagehandAct = vi.fn().mockResolvedValue(actResult());
    const params = {
      ...baseParams(page, stagehandAct),
      step: "Click the 'Review' summary panel to expand it",
      optional: false,
      submitStep: false,
      isFinalStep: true,
      flowHasSubmitSemantics: false,
      submitEndpointPattern: null,
      requireSubmitEndpointMatch: false,
      signalCounter: { n: 0 },
    };
    const stagehandObserve = (params.stagehand as unknown as { observe: ReturnType<typeof vi.fn> })
      .observe;

    await expect(executeStepWithHealing(params)).rejects.toMatchObject({
      name: "StepVerificationError",
    });

    // The deep-submit-locator's ranking expression must never be evaluated —
    // a read-only final step is not submit-shaped just because it's last.
    const rankCalls = evaluate.mock.calls.filter(([expr]) => String(expr).includes("ranked.sort"));
    expect(rankCalls.length).toBe(0);
    // Attempt 1 (act-string) + attempt 2 (observe-act, NOT skipped) both call
    // stagehand.act — proving attempts 3/4 (structured-click,
    // observe-act-exclude) were not short-circuited away either.
    expect(stagehandAct.mock.calls.length).toBeGreaterThan(1);
    expect(stagehandObserve).toHaveBeenCalled();
  });

  it("still escalates to the deep submit-control locator on a genuine submit-flow's final step (no regression)", async () => {
    // Paired control for the read-only case above: same isFinalStep:true
    // final-step shape, but this flow DOES carry real submit semantics
    // (flowHasSubmitSemantics:true) — the deep-submit-locator escalation on
    // attempt-1 phantom-click must still fire exactly as before the fix.
    const signalCounter = { n: 0 };
    const { page, evaluate } = fakePage({
      url: "https://apply.acme.example/jobs/1/apply-portal/apply",
      bodyHtmlLength: 184186,
      onDeepClick: () => {
        signalCounter.n += 1;
      },
    });
    const stagehandAct = vi.fn().mockResolvedValue(actResult());
    const params = {
      ...baseParams(page, stagehandAct),
      signalCounter,
      submitStep: false,
      isFinalStep: true,
      flowHasSubmitSemantics: true,
    };

    const result = await executeStepWithHealing(params);

    expect(result).toBe("completed");
    // Only attempt 1 (act-string) called stagehand.act — the escalation
    // routed straight to deep-submit-locator instead of repeating light-DOM
    // techniques, same as the existing submitStep:true escalation test.
    expect(stagehandAct).toHaveBeenCalledTimes(1);
    const rankCalls = evaluate.mock.calls.filter(([expr]) => String(expr).includes("ranked.sort"));
    expect(rankCalls.length).toBe(1);
  });

  it("falls through to the existing light-DOM techniques when only one deep candidate exists and it phantoms (control case)", async () => {
    // Same shape as the runner-up test, but with a single ranked candidate
    // — there is no ranked[1] to retry, so the branch must not attempt to
    // index past the array and must let the cascade continue to
    // structured-click / observe-act-exclude / llm-rephrase as before.
    const { page, evaluate } = fakePage({
      url: "https://apply.acme.example/jobs/1/apply-portal/apply",
      bodyHtmlLength: 184186,
      rankedCandidates: [{ deepIndex: 7, tier: 3, tag: "button", accessibleName: "submit" }],
    });
    const stagehandAct = vi.fn().mockResolvedValue(actResult());
    const params = { ...baseParams(page, stagehandAct), signalCounter: { n: 0 } };

    await expect(executeStepWithHealing(params)).rejects.toMatchObject({
      name: "StepVerificationError",
      kind: "phantom-click-exhausted",
    });
    const clickByIndexCalls = evaluate.mock.calls
      .filter(([expr]) => String(expr).includes('__mouse("click"'))
      .map(([expr]) => Number(String(expr).match(/all\[(\d+)\]/)?.[1]));
    expect(clickByIndexCalls).toEqual([7]);
  });
});

describe("flow-runner/executeStepWithHealing — observe-act method override for fill steps", () => {
  const STEP = "Fill in the Zip field with '78701'";

  function actResult(overrides: Partial<ActResult> = {}): ActResult {
    return {
      success: true,
      message: "filled",
      actionDescription: "filled Zip",
      actions: [],
      ...overrides,
    };
  }

  function fakePage(params: { url: string; bodyHtmlLength: number }): {
    page: Page;
    evaluate: ReturnType<typeof vi.fn>;
  } {
    const url = params.url;
    const evaluate = vi.fn().mockImplementation(async (expr: unknown) => {
      const src = String(expr);
      if (src.includes("outerHTML")) {
        return { html: params.bodyHtmlLength, text: `0:` };
      }
      if (src.includes("isInvalid(el)")) {
        return 0;
      }
      return null;
    });
    const page = {
      evaluate,
      url: () => url,
      title: vi.fn().mockResolvedValue("Apply"),
      locator: vi.fn().mockReturnValue({
        first: () => ({
          isChecked: vi.fn().mockResolvedValue(false),
          inputValue: vi.fn().mockResolvedValue("78701"),
        }),
      }),
      waitForTimeout: vi.fn().mockResolvedValue(undefined),
    } as unknown as Page;
    return { page, evaluate };
  }

  function baseParams(page: Page, stagehandAct: ReturnType<typeof vi.fn>) {
    const stagehand = {
      act: stagehandAct,
      observe: vi
        .fn()
        .mockResolvedValue([{ selector: "input", description: "Zip Code *", method: "click" }]),
    } as unknown as Stagehand;
    return {
      stagehand,
      page,
      step: STEP,
      optional: false,
      upload: false,
      submitStep: false,
      flowHasSubmitSemantics: true,
      stepIndex: 11,
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

  it("overrides observe candidate method='click' to method='fill' with arguments=['78701'] before calling act", async () => {
    const signalCounter = { n: 0 };
    const { page } = fakePage({
      url: "https://careers.example.org/jobs/123/apply",
      bodyHtmlLength: 184186,
    });

    type CapturedTarget = { method?: string; arguments?: unknown[] };
    let capturedTarget: CapturedTarget | null = null;
    const stagehandAct = vi.fn().mockImplementation(async (target) => {
      if (typeof target === "object" && target !== null && "method" in target) {
        capturedTarget = target as CapturedTarget;
        signalCounter.n += 1;
      }
      return actResult();
    });
    const params = { ...baseParams(page, stagehandAct), signalCounter };

    const result = await executeStepWithHealing(params);

    expect(result).toBe("completed");
    expect(capturedTarget).not.toBeNull();
    const target = capturedTarget as unknown as CapturedTarget;
    expect(target.method).toBe("fill");
    expect(target.arguments).toEqual(["78701"]);
  });
});

describe("flow-runner/runHealingFlow", () => {
  /**
   * Fake page satisfying `wireSignalCapture`'s CDP plumbing plus the plain
   * DOM-evaluate surface `executeStepWithHealing` touches for a non-select/
   * non-checkbox/non-radio instruction (DOM snapshot + invalid-marker count
   * only — the select/checkbox/radio primitives all no-op on such a step
   * because none of their instruction parsers match it).
   */
  function fakeFlowPage(
    getUrl: () => string = () => "https://apply.acme.example/jobs/1/apply"
  ): Page {
    const session = { on: () => {}, off: () => {} };
    const evaluate = vi.fn().mockImplementation(async (expr: unknown) => {
      const src = String(expr);
      if (src.includes("outerHTML")) return { html: 184186, text: "0:" };
      if (src.includes("isInvalid(el)")) return 0;
      return null;
    });
    return {
      evaluate,
      url: getUrl,
      title: vi.fn().mockResolvedValue("Apply"),
      locator: vi.fn().mockReturnValue({
        first: () => ({
          isChecked: vi.fn().mockResolvedValue(false),
          inputValue: vi.fn().mockResolvedValue(""),
        }),
      }),
      waitForTimeout: vi.fn().mockResolvedValue(undefined),
      getSessionForFrame: () => session,
      mainFrameId: () => "main",
      sendCDP: vi.fn().mockResolvedValue({ body: "{}", base64Encoded: false }),
    } as unknown as Page;
  }

  /** Non-submit-shaped, non-select/checkbox/radio instruction. */
  const STEP_A = "Fill in the middle name field";

  function step(overrides: Partial<HealingFlowStep> = {}): HealingFlowStep {
    return { instruction: STEP_A, optional: false, upload: false, submitStep: false, ...overrides };
  }

  it("throws StepVerificationError kind 'flow-timeout' carrying the current stepIndex once maxFlowMs elapses", async () => {
    // Date.now() advances by 50ms every time stagehand.observe (the probe)
    // is called, so the SECOND step's loop-entry deadline check (budget:
    // 10ms) fires — the first step is allowed to run to completion
    // (checked once per iteration, not mid-step). The URL flips on act so
    // step 1 verifies via `urlChanged` instead of grinding the cascade.
    let now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const urls = { current: "https://apply.acme.example/jobs/1/apply" };
    const stagehand = {
      observe: vi.fn().mockImplementation(async () => {
        now += 50;
        return [{ selector: "input#mname", description: "middle name", method: "fill" }];
      }),
      act: vi.fn().mockImplementation(async () => {
        urls.current = "https://apply.acme.example/jobs/1/apply/step-2";
        return {
          success: true,
          message: "filled",
          actionDescription: "Fill in the middle name field",
          actions: [{ selector: "input#mname", description: "middle name", method: "fill" }],
        };
      }),
    } as unknown as Stagehand;
    const page = fakeFlowPage(() => urls.current);

    await expect(
      runHealingFlow({
        stagehand,
        page,
        steps: [step(), step()],
        logger: testLogger,
        anthropic: null,
        rephraseModel: null,
        uploadFixture: null,
        maxFlowMs: 10,
      })
    ).rejects.toMatchObject({
      name: "StepVerificationError",
      kind: "flow-timeout",
      message: expect.stringContaining("step 2"),
    });

    vi.restoreAllMocks();
  });

  it("completes under budget and returns submitVerified:true when the submitStep verifies", async () => {
    // Verification (with submitEndpointPattern:null, the default) accepts a
    // post-attempt URL change as proof of effect — the same `urlChanged`
    // signal snapshotPage/executeStepWithHealing already use. The fake
    // page's url() flips to the post-submit URL the instant stagehand.act
    // resolves, simulating a real submit navigation.
    let url = "https://apply.acme.example/jobs/1/apply";
    const stagehand = {
      observe: vi
        .fn()
        .mockResolvedValue([{ selector: "button#submit", description: "submit", method: "click" }]),
      act: vi.fn().mockImplementation(async () => {
        url = "https://apply.acme.example/jobs/1/apply/thank-you";
        return {
          success: true,
          message: "clicked",
          actionDescription: "Click the Submit button",
          actions: [
            { selector: "button#submit", description: "Click the Submit button", method: "click" },
          ],
        };
      }),
    } as unknown as Stagehand;
    const page = fakeFlowPage(() => url);

    const result = await runHealingFlow({
      stagehand,
      page,
      steps: [step({ submitStep: true, instruction: "Click the Submit button" })],
      logger: testLogger,
      anthropic: null,
      rephraseModel: null,
      uploadFixture: null,
    });

    expect(result).toMatchObject({
      submitVerified: true,
      submitStepSkipped: false,
      lastStepIndex: 0,
    });
  });

  it("preserves current behavior (no deadline error) when maxFlowMs is omitted", async () => {
    let stepCount = 0;
    const urls = { current: "https://apply.acme.example/jobs/1/apply" };
    const stagehand = {
      observe: vi
        .fn()
        .mockResolvedValue([
          { selector: "input#mname", description: "middle name", method: "fill" },
        ]),
      act: vi.fn().mockImplementation(async () => {
        // Each step's act navigates to a fresh URL so its own pre/post
        // snapshot sees a delta (urlChanged) — a URL that only changed once
        // across the whole flow would false-negative step 2, since its
        // pre-snapshot would already be on the post-step-1 URL.
        stepCount += 1;
        urls.current = `https://apply.acme.example/jobs/1/apply/step-${stepCount}`;
        return {
          success: true,
          message: "filled",
          actionDescription: "Fill in the middle name field",
          actions: [{ selector: "input#mname", description: "middle name", method: "fill" }],
        };
      }),
    } as unknown as Stagehand;
    const page = fakeFlowPage(() => urls.current);

    const result = await runHealingFlow({
      stagehand,
      page,
      steps: [step(), step()],
      logger: testLogger,
      anthropic: null,
      rephraseModel: null,
      uploadFixture: null,
    });

    expect(result).toMatchObject({
      submitVerified: false,
      submitStepSkipped: false,
      lastStepIndex: 1,
    });
  });

  it("throws StepVerificationError kind 'submit-skipped' and never reports success when the submitStep is skipped", async () => {
    // The probe returns zero candidates for BOTH the focused and unfocused
    // observe calls, and the step is optional — the exact "probe found no
    // candidates" fast-skip path executeStepWithHealing takes at
    // flow-runner.ts:5408-5422, so the submit step resolves "skipped"
    // without ever reaching the cascade.
    const stagehand = {
      observe: vi.fn().mockResolvedValue([]),
      act: vi.fn(),
    } as unknown as Stagehand;
    const page = fakeFlowPage();

    await expect(
      runHealingFlow({
        stagehand,
        page,
        steps: [step({ submitStep: true, optional: true, instruction: "Click the Submit button" })],
        logger: testLogger,
        anthropic: null,
        rephraseModel: null,
        uploadFixture: null,
      })
    ).rejects.toMatchObject({
      name: "StepVerificationError",
      kind: "submit-skipped",
    });
    expect(stagehand.act).not.toHaveBeenCalled();
  });
});

describe("flow-runner/extractLivePageFormEvidence", () => {
  /** Angular-invalid markup with one leaf field and one clickable interactive target next to it. */
  const IFRAME_INVALID_HTML =
    '<div class="ng-invalid"><label class="question-title">State</label>' +
    "<app-input></app-input><label>Colorado</label></div>";

  it("probes the caller-supplied child FrameTarget instead of re-resolving the main frame", async () => {
    const childEvaluate = vi.fn().mockImplementation(async (expr: unknown) => {
      const src = String(expr);
      if (src.includes("document.body ? document.body.outerHTML")) return IFRAME_INVALID_HTML;
      if (src.includes("errorTextFor")) {
        return [
          {
            xpath: "/html[1]/body[1]/div[1]",
            label: "State",
            framework: "angular",
            markerClass: "ng-invalid",
            visibleErrorText: null,
            inputTag: "app-input",
          },
        ];
      }
      if (src.includes("questionTitleOf")) {
        return ["[State] label 'Colorado' — xpath=/html[1]/body[1]/div[1]/label[2]"];
      }
      return null;
    });
    const childTarget: FrameTarget = {
      frame: {} as FrameTarget["frame"],
      frameSelector: "iframe#apply_frame",
      evaluate: childEvaluate,
      locator: vi.fn(),
      url: () => Promise.resolve("https://apply.example.com/application/abc-123"),
      title: () => Promise.resolve("Apply"),
    };
    const pageEvaluate = vi.fn().mockResolvedValue(null);
    const page = { evaluate: pageEvaluate } as unknown as Page;

    const evidence = await extractLivePageFormEvidence(page, childTarget);

    expect(evidence.invalidFieldList).toContain("State");
    expect(evidence.invalidFieldList).toContain("app-input");
    expect(evidence.interactiveTargetsList).toContain("Colorado");
    expect(pageEvaluate).not.toHaveBeenCalled();

    const leafProbeCalls = childEvaluate.mock.calls.filter(([expr]) =>
      String(expr).includes("errorTextFor")
    );
    expect(leafProbeCalls.length).toBe(1);
    const interactiveProbeCalls = childEvaluate.mock.calls.filter(([expr]) =>
      String(expr).includes("questionTitleOf")
    );
    expect(interactiveProbeCalls.length).toBe(1);
  });
});

describe("flow-runner/runHealingFlow — frameSelector routes the cascade to the resolved child frame", () => {
  /**
   * Generated by `frame-target.ts`'s `resolveFrameTarget` to read the
   * candidate iframe element's `src` off the main document — the one
   * `document.querySelector` shape that must always be answered by the
   * OUTER page, never the child frame, even once a frame is resolved.
   * Distinguished from the OTHER `document.querySelector(...)` probe
   * expressions the cascade builds (e.g. `submittedStateSelectors`) by the
   * `tagName !== "IFRAME"` guard unique to `resolveFrameTarget`'s expression.
   */
  const IFRAME_SRC_MARKER = 'tagName !== "IFRAME"';

  function step(overrides: Partial<HealingFlowStep> = {}): HealingFlowStep {
    return {
      instruction: "Fill in the middle name field",
      optional: false,
      upload: false,
      submitStep: false,
      ...overrides,
    };
  }

  /**
   * Fake page whose `evaluate` is a single spy (so call-count/argument
   * assertions are unambiguous) answering: the iframe-src resolution probe
   * (only when `iframeSrc` is supplied), the DOM snapshot/ng-invalid probes
   * every step touches, and otherwise `null`. `frames()` returns the given
   * child-frame fakes so `resolveFrameTarget` can match one by origin.
   */
  function fakeFlowPageWithFrame(params: {
    iframeSrc?: string;
    childFrameEvaluate?: ReturnType<typeof vi.fn>;
    childFrameUrl?: string;
  }): Page {
    const session = { on: () => {}, off: () => {} };
    const evaluate = vi.fn().mockImplementation(async (expr: unknown) => {
      const src = String(expr);
      if (src.includes(IFRAME_SRC_MARKER)) {
        return params.iframeSrc
          ? { matched: true, src: params.iframeSrc }
          : { matched: false, src: null };
      }
      if (src.includes("outerHTML")) return { html: 184186, text: "0:" };
      if (src.includes("isInvalid(el)")) return 0;
      return null;
    });
    const childFrame = params.childFrameEvaluate
      ? {
          evaluate: params.childFrameEvaluate,
          locator: vi.fn().mockReturnValue({
            first: () => ({
              isChecked: vi.fn().mockResolvedValue(false),
              inputValue: vi.fn().mockResolvedValue(""),
            }),
          }),
        }
      : null;
    return {
      evaluate,
      url: () => "https://careers.example.org/jobs/123",
      title: vi.fn().mockResolvedValue("Apply"),
      locator: vi.fn().mockReturnValue({
        first: () => ({
          isChecked: vi.fn().mockResolvedValue(false),
          inputValue: vi.fn().mockResolvedValue(""),
        }),
      }),
      waitForTimeout: vi.fn().mockResolvedValue(undefined),
      getSessionForFrame: () => session,
      mainFrameId: () => "main",
      sendCDP: vi.fn().mockResolvedValue({ body: "{}", base64Encoded: false }),
      frames: () => (childFrame ? [childFrame] : []),
    } as unknown as Page;
  }

  /** Stagehand whose act/observe always report a candidate but never verify (no url/network/dom effect) — guarantees the cascade exhausts every attempt. */
  function unhealableStagehand(): Stagehand {
    return {
      act: vi.fn().mockResolvedValue({
        success: true,
        message: "clicked",
        actionDescription: "Click the 'No' label for 'Are you a Contingent Worker?'",
        actions: [{ selector: "label#no", description: "No", method: "click" }],
      }),
      observe: vi
        .fn()
        .mockResolvedValue([{ selector: "label#no", description: "No", method: "click" }]),
    } as unknown as Stagehand;
  }

  const NON_SUBMIT_STEP = "Click the 'No' label for 'Are you currently a Contingent Worker?'";

  it("routes the cascade's DOM-direct evaluate calls to the resolved child frame when frameSelector matches an iframe", async () => {
    const childFrameEvaluate = vi.fn().mockImplementation(async (expr: unknown) => {
      if (expr === "location.href") return "https://apply.example.com/application/abc-123";
      const src = String(expr);
      if (src.includes("outerHTML")) return null;
      return null;
    });
    const page = fakeFlowPageWithFrame({
      iframeSrc: "https://apply.example.com/application/abc-123",
      childFrameEvaluate,
    });
    const pageEvaluate = page.evaluate as ReturnType<typeof vi.fn>;
    const stagehand = unhealableStagehand();

    await expect(
      runHealingFlow({
        stagehand,
        page,
        // A trailing second step keeps the failing step from being the
        // FINAL step of the flow — isFinalStep gates a still-unmigrated
        // extractLivePageFormEvidence call (flow-runner.ts:6878) onto
        // mainFrameTarget(page) unconditionally, which is orthogonal to
        // the terminal-dump routing this test targets.
        steps: [
          step({ instruction: NON_SUBMIT_STEP, submitStep: false }),
          step({ instruction: "Fill in the last name field", submitStep: false }),
        ],
        logger: testLogger,
        anthropic: null,
        rephraseModel: null,
        uploadFixture: null,
        frameSelector: "iframe#apply_frame",
      })
    ).rejects.toMatchObject({ name: "StepVerificationError" });

    // The cascade's terminal-dump body-outerHTML read (flow-runner.ts:6984,
    // `(frameTarget ?? page).evaluate(...)`) must land on the resolved child
    // frame's evaluate, not the outer page's — the exact seam this bugfix wires.
    const frameBodyReads = childFrameEvaluate.mock.calls.filter(([expr]) =>
      String(expr).includes("document.body ? document.body.outerHTML : null")
    );
    expect(frameBodyReads.length).toBeGreaterThan(0);
    const pageBodyReads = pageEvaluate.mock.calls.filter(([expr]) =>
      String(expr).includes("document.body ? document.body.outerHTML : null")
    );
    expect(pageBodyReads.length).toBe(0);

    // Stagehand's own observe calls (attempt 2 `observe-act`, attempt 4
    // `observe-act-exclude`, the terminal unfocused-observe dump) must also
    // carry the hop-scoped selector guardedObserve composes from
    // frameTarget.frameSelector (stagehand-guard.ts:154-171) — the mechanism
    // that scopes Stagehand's OWN candidate search into the resolved frame,
    // distinct from the raw evaluate/locator routing asserted above. The
    // pre-cascade reachability probe (flow-runner.ts:5540) is a documented
    // gap that never receives frameTarget, so it's excluded rather than
    // asserted on here — see the criteria file's regression-guard note.
    const observeCalls = (stagehand.observe as ReturnType<typeof vi.fn>).mock.calls;
    const scopedCalls = observeCalls.filter(
      (call) => (call.at(-1) as { selector?: string } | undefined)?.selector !== undefined
    );
    expect(scopedCalls.length).toBeGreaterThan(0);
    for (const call of scopedCalls) {
      const options = call.at(-1) as { selector?: string };
      expect(options.selector).toBe("iframe#apply_frame >> *");
    }
  });

  it("never resolves or touches a child frame when frameSelector is omitted — every evaluate call lands on the page", async () => {
    const childFrameEvaluate = vi.fn();
    const page = fakeFlowPageWithFrame({
      // A real iframe exists on the page and a real matching frame is
      // attached, but frameSelector is never passed to runHealingFlow — so
      // resolveFrameTarget(page, undefined) must short-circuit to the
      // main-frame target WITHOUT ever probing for the iframe or reading
      // page.frames().
      iframeSrc: "https://apply.example.com/application/abc-123",
      childFrameEvaluate,
    });
    const pageEvaluate = page.evaluate as ReturnType<typeof vi.fn>;
    const stagehand = unhealableStagehand();

    await expect(
      runHealingFlow({
        stagehand,
        page,
        steps: [step({ instruction: NON_SUBMIT_STEP, submitStep: false })],
        logger: testLogger,
        anthropic: null,
        rephraseModel: null,
        uploadFixture: null,
        // frameSelector omitted
      })
    ).rejects.toMatchObject({ name: "StepVerificationError" });

    expect(childFrameEvaluate).not.toHaveBeenCalled();
    const pageBodyReads = pageEvaluate.mock.calls.filter(([expr]) =>
      String(expr).includes("document.body ? document.body.outerHTML : null")
    );
    expect(pageBodyReads.length).toBeGreaterThan(0);

    // No stagehand.observe call ever carries a selector — byte-identical to
    // pre-frame-target behavior for every existing main-frame-only site.
    const observeCalls = (stagehand.observe as ReturnType<typeof vi.fn>).mock.calls;
    expect(observeCalls.length).toBeGreaterThan(0);
    for (const call of observeCalls) {
      const options = call.at(-1) as { selector?: string } | undefined;
      expect(options?.selector).toBeUndefined();
    }
  });

  it("falls back to the main frame and still completes (never throws) when frameSelector matches no live frame", async () => {
    // The iframe element exists in the DOM (iframeSrc resolves) but no
    // page.frames() entry has a matching origin — resolveFrameTarget's
    // fallback path 3 (frame-target.ts:135-141). The step still verifies
    // normally via the existing urlChanged signal on attempt 1, proving a
    // selector typo degrades to today's main-frame behavior instead of
    // failing the run.
    let url = "https://careers.example.org/jobs/123";
    const page = fakeFlowPageWithFrame({
      iframeSrc: "https://apply.example.com/application/abc-123",
      // No childFrameEvaluate supplied — frames() returns [] so no candidate
      // frame exists to match the resolved iframe origin against.
    });
    Object.defineProperty(page, "url", { value: () => url });
    const stagehand = {
      observe: vi
        .fn()
        .mockResolvedValue([{ selector: "button#submit", description: "submit", method: "click" }]),
      act: vi.fn().mockImplementation(async () => {
        url = "https://careers.example.org/jobs/123/thank-you";
        return {
          success: true,
          message: "clicked",
          actionDescription: "Click the Submit button",
          actions: [
            { selector: "button#submit", description: "Click the Submit button", method: "click" },
          ],
        };
      }),
    } as unknown as Stagehand;

    const result = await runHealingFlow({
      stagehand,
      page,
      steps: [step({ submitStep: true, instruction: "Click the Submit button" })],
      logger: testLogger,
      anthropic: null,
      rephraseModel: null,
      uploadFixture: null,
      frameSelector: "iframe#apply_frame",
    });

    expect(result).toMatchObject({
      submitVerified: true,
      submitStepSkipped: false,
      lastStepIndex: 0,
    });
  });
});

describe("flow-runner/parseSelectStep — filler-word phrasing between verb and quote", () => {
  it("parses 'select the option \\'X\\'' with no question label", () => {
    expect(parseSelectStep("select the option 'Job Boards' from the popup list")).toEqual({
      option: "Job Boards",
      questionLabel: null,
    });
  });

  it("parses 'select the answer \\'X\\'' with a question label still present", () => {
    expect(
      parseSelectStep("For 'How did you hear about this position?' select the answer 'Job Boards'")
    ).toEqual({
      option: "Job Boards",
      questionLabel: "How did you hear about this position?",
    });
  });

  it("still parses the pre-existing 'select \\'X\\' in the \\'Y\\' dropdown' phrasing unchanged", () => {
    expect(parseSelectStep("Select 'Texas' in the State or State/Region dropdown")).toEqual({
      option: "Texas",
      questionLabel: null,
    });
  });

  it("picks the widget's own quoted label over an unrelated leading page/step-context quote", () => {
    expect(
      parseSelectStep(
        "On the authenticated 'My Information' step, open the 'How Did You Hear About Us?' prompt selector (data-automation-id='source'), then select the option 'Job Boards' from the popup list"
      )
    ).toEqual({
      option: "Job Boards",
      questionLabel: "How Did You Hear About Us?",
    });
  });

  it("picks the widget's own quoted label when the step is phrased as 'multiselect' rather than 'dropdown'/'prompt selector'", () => {
    expect(
      parseSelectStep(
        "On the authenticated 'My Information' step, open the 'How Did You Hear About Us?' multiselect, then select the option 'Job Boards' from the popup list"
      )
    ).toEqual({
      option: "Job Boards",
      questionLabel: "How Did You Hear About Us?",
    });
  });
});

describe("flow-runner/parseRadioStep — leading page/step-context quote before 'for the question'", () => {
  it("picks the 'for the question' quoted label over an unrelated leading page/step-context quote", () => {
    expect(
      parseRadioStep(
        "On the authenticated 'My Information' page, click the 'Yes' answer for the question 'Are you at least 18 years of age?'"
      )
    ).toEqual({
      option: "Yes",
      questionLabel: "Are you at least 18 years of age?",
    });
  });

  it("still parses the pre-existing 'click the answer for the question' phrasing unchanged", () => {
    expect(
      parseRadioStep("Click the 'Yes' answer for the question 'Are you at least 18 years of age?'")
    ).toEqual({
      option: "Yes",
      questionLabel: "Are you at least 18 years of age?",
    });
  });
});
