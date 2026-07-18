import type { Page } from "@browserbasehq/stagehand";
import { describe, expect, it, vi } from "vitest";

import { formatStepPrefix, waitForSpaReady, wireSignalCapture } from "@/scraper/flow-runner";
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
