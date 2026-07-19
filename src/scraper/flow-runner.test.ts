import type { ActResult, Page, Stagehand } from "@browserbasehq/stagehand";
import { describe, expect, it, vi } from "vitest";

import {
  executeStepWithHealing,
  formatStepPrefix,
  waitForSpaReady,
  wireSignalCapture,
} from "@/scraper/flow-runner";
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
      if (src.includes('dispatchEvent(new Event("click"')) {
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
      stepIndex: 76,
      phase: "apply",
      signalCounter: { n: 0 },
      recentCaptures: [],
      recentCaptureMeta: [],
      anthropic: null,
      logger: testLogger,
      captureFn: vi.fn().mockResolvedValue(undefined),
      resumeFixture: null,
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
      String(expr).includes('dispatchEvent(new Event("click"')
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
      if (src.includes('dispatchEvent(new Event("click"')) return { clicked: false };
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
      String(expr).includes('dispatchEvent(new Event("click"')
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
      if (src.includes('dispatchEvent(new Event("click"')) {
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
      String(expr).includes('dispatchEvent(new Event("click"')
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
      if (src.includes('dispatchEvent(new Event("click"')) {
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
      .filter(([expr]) => String(expr).includes('dispatchEvent(new Event("click"'))
      .map(([expr]) => Number(String(expr).match(/all\[(\d+)\]/)?.[1]));
    // Top pick (7) clicked first, then the runner-up (12) — both by
    // deep-index, extending the existing `deep-index:N` pseudo-selector
    // convention rather than a new format.
    expect(clickByIndexCalls).toEqual([7, 12]);
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
      .filter(([expr]) => String(expr).includes('dispatchEvent(new Event("click"'))
      .map(([expr]) => Number(String(expr).match(/all\[(\d+)\]/)?.[1]));
    expect(clickByIndexCalls).toEqual([7]);
  });
});
