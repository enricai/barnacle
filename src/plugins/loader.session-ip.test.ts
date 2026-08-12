import { isValid, parseISO } from "date-fns";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { dispatch } from "@/plugins/loader";
import type { SitePlugin, SitePluginContext } from "@/site-plugin";

// vi.hoisted runs before vi.mock factories — required so these references
// are available when the factory closures execute. Scaffolding parallels
// loader.test.ts:34-101 so both files exercise the same mocked boundary.
const mockCaptureSubmissionEnvelope = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockRunWithSession = vi.hoisted(() =>
  vi.fn().mockImplementation((task: (session: null) => Promise<unknown>) => task(null))
);

vi.mock("@/scraper/pool", () => ({
  runWithSession: mockRunWithSession,
}));

vi.mock("@/lib/telemetry/submission-capture", () => ({
  captureSubmissionEnvelope: mockCaptureSubmissionEnvelope,
}));

vi.mock("@/scraper/metrics", () => ({
  recordHotPathSuccess: vi.fn(),
  recordFallbackActivation: vi.fn(),
  recordRateLimitRejection: vi.fn(),
  recordHotPathLatency: vi.fn(),
  allMetrics: vi.fn().mockReturnValue({}),
  resetMetrics: vi.fn(),
}));

vi.mock("@/cache/response-cache", () => ({
  getCachedResponse: vi.fn().mockReturnValue({ value: undefined, key: "test-key" }),
  getOrCreateInFlight: vi
    .fn()
    .mockImplementation((_key: string, producer: () => Promise<unknown>) => producer()),
}));

vi.mock("@/lib/tracking-click", () => ({
  fireTrackingClick: vi.fn(),
}));

vi.mock("@/lib/telemetry/beacon-capture", () => ({
  captureBeaconEvent: vi.fn().mockResolvedValue(undefined),
  createBeaconOutcomeRecorder: vi.fn(() => vi.fn().mockResolvedValue(undefined)),
}));

vi.mock("@/lib/dd-metrics", () => ({
  recordDdAttempt: vi.fn(),
  recordDdSuccess: vi.fn(),
  recordDdFailure: vi.fn(),
  recordDdDuration: vi.fn(),
  recordDdFallback: vi.fn(),
  recordDdRateLimit: vi.fn(),
}));

/**
 * Fake `BrowserSession` (`src/scraper/session-shared.ts`) carrying a known
 * outbound IP via the `getOutboundIp()` accessor. Untyped (no
 * `: BrowserSession` annotation) since `runWithSession` is fully mocked
 * below, so nothing here crosses a real type boundary.
 */
function createFakeSession(ip: string | null = "203.0.113.42") {
  return {
    stagehand: {},
    limiter: {},
    sessionId: "sess_abc123",
    provider: "browserbase" as const,
    close: vi.fn().mockResolvedValue(undefined),
    getOutboundIp: vi.fn().mockResolvedValue(ip),
  };
}

/** Session identity/network facts `RunTelemetry.recordSession()` (feat-005) accepts. */
interface SessionTelemetryStub {
  sessionId: string;
  provider: string;
  ip: string | null;
  ipCapturedAt: string | null;
}

/**
 * Minimal stand-in for the `RunTelemetry` collector
 * (`src/lib/telemetry/run-telemetry.ts`) that `SitePluginContext.telemetry`
 * exposes. Reimplemented locally rather than imported so this file exercises
 * `dispatch()` against the documented contract shape (`recordSession()`
 * last-write-wins, `snapshot().session` is `null` until a session is
 * recorded, `snapshot().joinKeys` stays `null` since this file never calls
 * `addJoinKeys()`) independent of the real class.
 */
interface RunTelemetryStub {
  recordSession: (info: SessionTelemetryStub) => void;
  snapshot: () => {
    joinKeys: Record<string, unknown> | null;
    session: SessionTelemetryStub | null;
  };
}

function createTelemetryStub(): RunTelemetryStub {
  let session: SessionTelemetryStub | null = null;
  return {
    recordSession: vi.fn((info: SessionTelemetryStub) => {
      session = info;
    }),
    snapshot: vi.fn(() => ({ joinKeys: null, session })),
  };
}

function buildContext(): SitePluginContext {
  const context = {
    baseUrl: "https://example.com",
    logger: {
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    } as unknown as SitePluginContext["logger"],
    config: {} as SitePluginContext["config"],
    requestId: "req-session-ip-123",
    metricsCollector: {
      startStep: vi.fn(),
      endStep: vi.fn(),
      markRetry: vi.fn(),
      finalize: vi.fn(() => ({
        totalDurationMs: 0,
        path: "http" as const,
        steps: [],
        attemptCount: 1,
        startedAt: "",
        endedAt: "",
        recordedAt: "",
      })),
    } as unknown as SitePluginContext["metricsCollector"],
    recordBeaconOutcome: vi.fn().mockResolvedValue(undefined),
    telemetry: createTelemetryStub(),
  };
  // This file's stub only implements the session half of RunTelemetry's
  // contract — addJoinKeys is out of scope here (no plugin in this file
  // calls it, and joinKeys stays null throughout).
  return context as unknown as SitePluginContext;
}

const successResult = { data: { result: "ok" }, auditPayload: { redacted: true } };

/**
 * Covers the seam `dispatch()` (`src/plugins/loader.ts`) bridges:
 * `runWithSession` (`src/scraper/pool.ts:46-84`) creates and closes the
 * `BrowserSession` entirely inside the pool callback, and only
 * `plugin.execute(payload, session, context)` ever sees it — so recording
 * the session's outbound IP onto the durable submission envelope requires
 * threading it back out via context/result, not just having the accessor
 * exist. Per the documented design (`docs/telemetry-and-judging.md`,
 * "session" field): the submit record carries
 * `session: { id, provider, ip, ipCapturedAt } | null`, populated once per
 * dispatch from `{ id: session.sessionId, provider: session.provider, ip,
 * ipCapturedAt }` in a `finally` around the plugin's session-scoped work,
 * and `null` only when no `BrowserSession` was ever acquired (the
 * `executeHttp` hot path).
 */
describe("dispatch — records the acquired session's outbound IP on the submission envelope", () => {
  beforeEach(() => {
    mockCaptureSubmissionEnvelope.mockResolvedValue(undefined);
    mockRunWithSession.mockImplementation((task: (session: null) => Promise<unknown>) =>
      task(null)
    );
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("(a) carries the browser session's outbound IP on the success envelope", async () => {
    const fakeSession = createFakeSession("203.0.113.42");
    mockRunWithSession.mockImplementation((task: (session: unknown) => Promise<unknown>) =>
      task(fakeSession)
    );
    const context = buildContext();
    const plugin: SitePlugin<unknown, unknown> = {
      meta: {
        siteId: "test-site",
        displayName: "Test Site",
        bodySchema: {} as never,
        responseSchema: {} as never,
      },
      execute: vi.fn().mockResolvedValue(successResult),
    };

    await dispatch(plugin, {}, context);

    expect(fakeSession.getOutboundIp).toHaveBeenCalledTimes(1);
    expect(mockCaptureSubmissionEnvelope).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "submitted",
        session: expect.objectContaining({
          id: "sess_abc123",
          provider: "browserbase",
          ip: "203.0.113.42",
        }),
      })
    );
    const call = mockCaptureSubmissionEnvelope.mock.calls[0]?.[0] as {
      session: { ipCapturedAt: string | null };
    };
    expect(isValid(parseISO(call.session.ipCapturedAt as string))).toBe(true);
  });

  it("(b) still carries the browser session's outbound IP on the error envelope when execute() throws", async () => {
    const fakeSession = createFakeSession("198.51.100.7");
    mockRunWithSession.mockImplementation((task: (session: unknown) => Promise<unknown>) =>
      task(fakeSession)
    );
    const context = buildContext();
    const plugin: SitePlugin<unknown, unknown> = {
      meta: {
        siteId: "test-site",
        displayName: "Test Site",
        bodySchema: {} as never,
        responseSchema: {} as never,
      },
      execute: vi.fn().mockRejectedValue(new Error("boom")),
    };

    await expect(dispatch(plugin, {}, context)).rejects.toThrow("boom");

    expect(mockCaptureSubmissionEnvelope).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "error",
        errorMessage: "boom",
        session: {
          id: "sess_abc123",
          provider: "browserbase",
          ip: "198.51.100.7",
          ipCapturedAt: expect.any(String),
        },
      })
    );
  });

  it("(e) pairs a null outbound IP with a null ipCapturedAt when getOutboundIp resolves null", async () => {
    const fakeSession = createFakeSession(null);
    mockRunWithSession.mockImplementation((task: (session: unknown) => Promise<unknown>) =>
      task(fakeSession)
    );
    const context = buildContext();
    const plugin: SitePlugin<unknown, unknown> = {
      meta: {
        siteId: "test-site",
        displayName: "Test Site",
        bodySchema: {} as never,
        responseSchema: {} as never,
      },
      execute: vi.fn().mockResolvedValue(successResult),
    };

    await dispatch(plugin, {}, context);

    expect(mockCaptureSubmissionEnvelope).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "submitted",
        session: {
          id: "sess_abc123",
          provider: "browserbase",
          ip: null,
          ipCapturedAt: null,
        },
      })
    );
  });

  it("(f) pairs a null outbound IP with a null ipCapturedAt for a session with no getOutboundIp accessor (Steel)", async () => {
    const steelSession = {
      stagehand: {},
      limiter: {},
      sessionId: "sess_steel_456",
      provider: "steel" as const,
      close: vi.fn().mockResolvedValue(undefined),
    };
    mockRunWithSession.mockImplementation((task: (session: unknown) => Promise<unknown>) =>
      task(steelSession)
    );
    const context = buildContext();
    const plugin: SitePlugin<unknown, unknown> = {
      meta: {
        siteId: "test-site",
        displayName: "Test Site",
        bodySchema: {} as never,
        responseSchema: {} as never,
      },
      execute: vi.fn().mockResolvedValue(successResult),
    };

    await dispatch(plugin, {}, context);

    expect(mockCaptureSubmissionEnvelope).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "submitted",
        session: {
          id: "sess_steel_456",
          provider: "steel",
          ip: null,
          ipCapturedAt: null,
        },
      })
    );
  });

  it("(c) records session: null on the success envelope for a hot-path run that never acquires a session", async () => {
    const context = buildContext();
    const plugin: SitePlugin<unknown, unknown> = {
      meta: {
        siteId: "test-site",
        displayName: "Test Site",
        bodySchema: {} as never,
        responseSchema: {} as never,
      },
      // Should not be invoked: executeHttp resolving means the browser path
      // (and therefore runWithSession/the session pool) is never reached.
      execute: vi.fn().mockRejectedValue(new Error("execute() should not run")),
      executeHttp: vi.fn().mockResolvedValue(successResult),
    };

    await dispatch(plugin, {}, context);

    expect(mockRunWithSession).not.toHaveBeenCalled();
    expect(mockCaptureSubmissionEnvelope).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "submitted",
        session: null,
      })
    );
  });

  it("(d) a browser-path run with no session ever acquired keeps today's envelope fields intact (regression guard)", async () => {
    const payload = { jobId: "job-1" };
    const context = buildContext();
    const plugin: SitePlugin<unknown, unknown> = {
      meta: {
        siteId: "test-site",
        displayName: "Test Site",
        bodySchema: {} as never,
        responseSchema: {} as never,
      },
      execute: vi.fn().mockResolvedValue(successResult),
    };

    await dispatch(plugin, payload, context);

    // Deliberately objectContaining, not full deep-equality: this subtask
    // (Gap 2, session-IP capture) adds an unrelated `session` key to this
    // same envelope call. Asserting the full key set here would couple this
    // regression guard to that sibling change.
    expect(mockCaptureSubmissionEnvelope).toHaveBeenCalledWith(
      expect.objectContaining({
        siteId: "test-site",
        requestId: "req-session-ip-123",
        joinKeys: null,
        inboundPayload: payload,
        status: "submitted",
        auditPayload: { redacted: true },
        errorMessage: null,
      })
    );
  });
});
