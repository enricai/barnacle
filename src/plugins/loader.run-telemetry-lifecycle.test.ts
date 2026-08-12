import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SessionTelemetry } from "@/lib/telemetry/run-telemetry";
import { dispatch } from "@/plugins/loader";
import type { SitePlugin, SitePluginContext } from "@/site-plugin";

// vi.hoisted runs before vi.mock factories — required so these references
// are available when the factory closures execute.
const mockCaptureSubmissionEnvelope = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockCaptureBeaconEvent = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockFireTrackingClick = vi.hoisted(() => vi.fn());
const mockGetCachedResponse = vi.hoisted(() =>
  vi.fn().mockReturnValue({ value: undefined, key: "test-key" })
);
const mockGetOrCreateInFlight = vi.hoisted(() =>
  vi.fn().mockImplementation((_key: string, producer: () => Promise<unknown>) => producer())
);
const mockRunWithSession = vi.hoisted(() =>
  vi.fn().mockImplementation((task: (session: null) => Promise<unknown>) => task(null))
);

// Stub runWithSession so tests can script exactly how many times the pool
// invokes the task — the default single-call behavior parallels loader.test.ts;
// individual tests below override it to model a retry (two invocations).
vi.mock("@/scraper/pool", () => ({
  runWithSession: mockRunWithSession,
}));

// Stub the telemetry sinks so tests don't touch the real NDJSON/browser
// side effects and can assert on exactly what dispatch() hands them.
vi.mock("@/lib/telemetry/submission-capture", () => ({
  captureSubmissionEnvelope: mockCaptureSubmissionEnvelope,
}));

vi.mock("@/lib/telemetry/beacon-capture", () => ({
  captureBeaconEvent: mockCaptureBeaconEvent,
  createBeaconOutcomeRecorder: vi.fn(() => vi.fn().mockResolvedValue(undefined)),
}));

vi.mock("@/lib/tracking-click", () => ({
  fireTrackingClick: mockFireTrackingClick,
}));

vi.mock("@/cache/response-cache", () => ({
  getCachedResponse: mockGetCachedResponse,
  getOrCreateInFlight: mockGetOrCreateInFlight,
}));

vi.mock("@/scraper/metrics", () => ({
  recordHotPathSuccess: vi.fn(),
  recordFallbackActivation: vi.fn(),
  recordRateLimitRejection: vi.fn(),
  recordHotPathLatency: vi.fn(),
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
 * Local double for the mid-run join-keys accumulator `SitePluginContext`
 * exposes to plugins (Gap 1 in the run-telemetry plan: plugins need a way
 * to attach fields discovered during execute()/executeHttp(), not just fields
 * derivable up front from the inbound payload via `extractJoinKeys`). Parallels
 * the documented contract — successive `addJoinKeys()` calls merge with later
 * keys winning, and an untouched collector snapshots to `null` rather than
 * `{}` so it composes cleanly with the existing `joinKeys: null` precedent in
 * loader.test.ts. Modeled as a standalone double (matching how this file's
 * sibling `stubContext.metricsCollector` is a hand-built double, not the real
 * `MetricsCollector`) so this file exercises the lifecycle contract
 * `dispatch()` must uphold independent of the real accumulator's internals.
 */
interface RunTelemetryDouble {
  addJoinKeys(fields: Record<string, unknown>): void;
  recordSession(info: SessionTelemetry): void;
  snapshot(): { joinKeys: Record<string, unknown> | null; session: SessionTelemetry | null };
}

// recordSession() stores a defensive copy, whole-object last-write-wins —
// matching the real `RunTelemetry.recordSession` (src/lib/telemetry/run-telemetry.ts:66)
// so this file's session-lifecycle cases (ordering, retry, per-request
// isolation) exercise the documented contract, not a stub that discards the
// session. The real `withSessionTelemetry` wrapper in loader.ts calls
// `recordSession` unconditionally whenever `runWithSession` hands back a
// truthy session, so the double must implement it (with the real
// `SessionTelemetry` param shape, matching `RunTelemetryHandle`
// structurally) or dispatch() throws now that feat-005's wiring has landed.
function createRunTelemetryDouble(): RunTelemetryDouble {
  let joinKeys: Record<string, unknown> | null = null;
  let session: SessionTelemetry | null = null;
  return {
    addJoinKeys(fields) {
      joinKeys = { ...(joinKeys ?? {}), ...fields };
    },
    recordSession(info) {
      session = { ...info };
    },
    snapshot() {
      return {
        joinKeys: joinKeys ? { ...joinKeys } : null,
        session: session ? { ...session } : null,
      };
    },
  };
}

/** Narrows `SitePluginContext.telemetry` to this file's local double type. */
interface ContextWithTelemetry extends SitePluginContext {
  telemetry: RunTelemetryDouble;
}

function buildContext(requestId: string): ContextWithTelemetry {
  return {
    baseUrl: "https://example.com",
    logger: {
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    } as unknown as SitePluginContext["logger"],
    config: {} as SitePluginContext["config"],
    requestId,
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
    telemetry: createRunTelemetryDouble(),
  };
}

/**
 * Fake `BrowserSession` (`src/scraper/session-shared.ts`) carrying a known
 * sessionId/outbound IP via `getOutboundIp()`. Parameterized by sessionId (not
 * hardcoded, unlike loader.session-ip.test.ts's version) so the retry and
 * concurrency cases below can hand out several distinct sessions from one
 * scripted `runWithSession` implementation.
 */
function createFakeSession(sessionId: string, ip: string | null) {
  return {
    stagehand: {},
    limiter: {},
    sessionId,
    provider: "browserbase" as const,
    close: vi.fn().mockResolvedValue(undefined),
    getOutboundIp: vi.fn().mockResolvedValue(ip),
  };
}

function stubMeta(siteId: string): SitePlugin<unknown, unknown>["meta"] {
  return {
    siteId,
    displayName: siteId,
    bodySchema: {} as never,
    responseSchema: {} as never,
  };
}

function envelopeCallFor(siteId: string): Record<string, unknown> | undefined {
  return mockCaptureSubmissionEnvelope.mock.calls
    .map(([call]) => call as Record<string, unknown>)
    .find((call) => call.siteId === siteId);
}

beforeEach(() => {
  mockCaptureSubmissionEnvelope.mockResolvedValue(undefined);
  mockRunWithSession.mockImplementation((task: (session: null) => Promise<unknown>) => task(null));
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("dispatch — session-IP capture only fires after execute() settles", () => {
  // withSessionTelemetry (src/plugins/loader.ts:144-163) calls getOutboundIp()
  // only in its `finally`, after `run()` (which wraps execute()) has settled.
  // This is load-bearing, not incidental: session-ip.ts opens a throwaway
  // top-level tab via `stagehand.context.newPage()` — if that fired while
  // execute() were still mid-flow, the echo tab would steal the active page
  // out from under the plugin's own navigation and could itself trip bot
  // detection on the target site.
  it("has not called getOutboundIp by the time execute() starts, and calls it exactly once after a successful dispatch", async () => {
    const fakeSession = createFakeSession("sess-order-success", "203.0.113.10");
    mockRunWithSession.mockImplementation((task: (session: unknown) => Promise<unknown>) =>
      task(fakeSession)
    );
    const context = buildContext("req-order-success");
    let callsAtExecuteEntry = -1;
    const plugin: SitePlugin<unknown, unknown> = {
      meta: stubMeta("order-success-site"),
      execute: async () => {
        callsAtExecuteEntry = fakeSession.getOutboundIp.mock.calls.length;
        return { data: { result: "ok" }, auditPayload: {} };
      },
    };

    await dispatch(plugin, {}, context);

    expect(callsAtExecuteEntry).toBe(0);
    expect(fakeSession.getOutboundIp).toHaveBeenCalledTimes(1);
  });

  it("has not called getOutboundIp by the time execute() starts, and calls it exactly once after execute() throws", async () => {
    const fakeSession = createFakeSession("sess-order-error", "203.0.113.11");
    mockRunWithSession.mockImplementation((task: (session: unknown) => Promise<unknown>) =>
      task(fakeSession)
    );
    const context = buildContext("req-order-error");
    let callsAtExecuteEntry = -1;
    const plugin: SitePlugin<unknown, unknown> = {
      meta: stubMeta("order-error-site"),
      execute: async () => {
        callsAtExecuteEntry = fakeSession.getOutboundIp.mock.calls.length;
        throw new Error("execute boom");
      },
    };

    await expect(dispatch(plugin, {}, context)).rejects.toThrow("execute boom");

    expect(callsAtExecuteEntry).toBe(0);
    expect(fakeSession.getOutboundIp).toHaveBeenCalledTimes(1);
  });
});

describe("dispatch — run-telemetry per-request isolation", () => {
  it("does not leak fields attached via context.telemetry between two concurrent dispatches", async () => {
    const contextA = buildContext("req-a");
    const contextB = buildContext("req-b");

    const pluginA: SitePlugin<unknown, unknown> = {
      meta: stubMeta("site-a"),
      execute: async (_payload, _session, context) => {
        (context as ContextWithTelemetry).telemetry.addJoinKeys({ discoveredBySiteA: "value-a" });
        // Yield so pluginB's dispatch can run and complete while this one is
        // still in flight — a shared/module-level accumulator would leak here.
        await new Promise((resolve) => setTimeout(resolve, 5));
        return { data: { result: "a" }, auditPayload: {} };
      },
    };

    const pluginB: SitePlugin<unknown, unknown> = {
      meta: stubMeta("site-b"),
      execute: async (_payload, _session, context) => {
        (context as ContextWithTelemetry).telemetry.addJoinKeys({ discoveredBySiteB: "value-b" });
        return { data: { result: "b" }, auditPayload: {} };
      },
    };

    await Promise.all([dispatch(pluginA, {}, contextA), dispatch(pluginB, {}, contextB)]);

    expect(envelopeCallFor("site-a")?.joinKeys).toEqual({ discoveredBySiteA: "value-a" });
    expect(envelopeCallFor("site-b")?.joinKeys).toEqual({ discoveredBySiteB: "value-b" });
  });

  it("does not leak the acquired session's identity between two concurrent dispatches with distinct sessions", async () => {
    const contextA = buildContext("req-session-a");
    const contextB = buildContext("req-session-b");
    const sessionA = createFakeSession("sess-conc-a", "203.0.113.31");
    const sessionB = createFakeSession("sess-conc-b", "203.0.113.32");

    // dispatch(pluginA, ...) runs synchronously up to its first await before
    // dispatch(pluginB, ...) is invoked, so these two queued implementations
    // are consumed in the same order the two dispatches start — matching how
    // runWithSession is actually invoked once per dispatch call.
    mockRunWithSession.mockImplementationOnce((task: (session: unknown) => Promise<unknown>) =>
      task(sessionA)
    );
    mockRunWithSession.mockImplementationOnce((task: (session: unknown) => Promise<unknown>) =>
      task(sessionB)
    );

    const pluginA: SitePlugin<unknown, unknown> = {
      meta: stubMeta("session-conc-site-a"),
      execute: async () => {
        // Yield so pluginB's dispatch can run and complete while this one is
        // still in flight — a shared/module-level session field would leak here.
        await new Promise((resolve) => setTimeout(resolve, 5));
        return { data: { result: "a" }, auditPayload: {} };
      },
    };
    const pluginB: SitePlugin<unknown, unknown> = {
      meta: stubMeta("session-conc-site-b"),
      execute: async () => ({ data: { result: "b" }, auditPayload: {} }),
    };

    await Promise.all([dispatch(pluginA, {}, contextA), dispatch(pluginB, {}, contextB)]);

    expect(envelopeCallFor("session-conc-site-a")?.session).toEqual({
      id: "sess-conc-a",
      provider: "browserbase",
      ip: "203.0.113.31",
      ipCapturedAt: expect.any(String),
    });
    expect(envelopeCallFor("session-conc-site-b")?.session).toEqual({
      id: "sess-conc-b",
      provider: "browserbase",
      ip: "203.0.113.32",
      ipCapturedAt: expect.any(String),
    });
  });

  it("keeps each context's own collector snapshot free of the other request's fields", () => {
    const contextA = buildContext("req-a");
    const contextB = buildContext("req-b");

    contextA.telemetry.addJoinKeys({ onlyA: "1" });
    contextB.telemetry.addJoinKeys({ onlyB: "2" });

    expect(contextA.telemetry.snapshot().joinKeys).toEqual({ onlyA: "1" });
    expect(contextB.telemetry.snapshot().joinKeys).toEqual({ onlyB: "2" });
  });
});

describe("dispatch — run-telemetry across a pool retry", () => {
  it("reflects only the final attempt's joinKeys, not a stale value from a failed attempt", async () => {
    const context = buildContext("req-retry");

    // Models runWithSession's own retry loop (src/scraper/pool.ts:64-84):
    // the task is invoked once per attempt, on a fresh session, until one
    // succeeds. Attempt 1 attaches a field and fails; attempt 2 attaches the
    // same key with a different value and succeeds.
    mockRunWithSession.mockImplementationOnce(
      async (task: (session: { attempt: number }) => Promise<unknown>) => {
        await task({ attempt: 1 }).catch(() => undefined);
        return task({ attempt: 2 });
      }
    );

    let executeCallCount = 0;
    const retryPlugin: SitePlugin<unknown, unknown> = {
      meta: stubMeta("retry-site"),
      execute: async (_payload, session, context) => {
        executeCallCount += 1;
        const typedContext = context as ContextWithTelemetry;
        const { attempt } = session as unknown as { attempt: number };
        if (attempt === 1) {
          typedContext.telemetry.addJoinKeys({ token: "stale-token-from-attempt-1" });
          throw new Error("attempt 1 failed");
        }
        typedContext.telemetry.addJoinKeys({ token: "fresh-token-from-attempt-2" });
        return { data: { result: "ok" }, auditPayload: {} };
      },
    };

    await dispatch(retryPlugin, {}, context);

    expect(executeCallCount).toBe(2);
    expect(envelopeCallFor("retry-site")).toEqual(
      expect.objectContaining({
        siteId: "retry-site",
        status: "submitted",
        joinKeys: { token: "fresh-token-from-attempt-2" },
      })
    );
  });

  it("carries only the final attempt's session onto the envelope, not the failed attempt's (session-restart retry)", async () => {
    const context = buildContext("req-session-retry");

    // Models src/scraper/pool.ts:64-84's session-restart path: a
    // SessionTimeoutError on attempt 1 tears down that session and
    // createBrowserSession mints a fresh one (sess-2) for attempt 2, unlike
    // the joinKeys retry test above where both attempts share one session.
    const sessionAttempt1 = createFakeSession("sess-1", "203.0.113.1");
    const sessionAttempt2 = createFakeSession("sess-2", "203.0.113.2");
    mockRunWithSession.mockImplementationOnce(
      async (task: (session: unknown) => Promise<unknown>) => {
        await task(sessionAttempt1).catch(() => undefined);
        return task(sessionAttempt2);
      }
    );

    let executeCallCount = 0;
    const retryPlugin: SitePlugin<unknown, unknown> = {
      meta: stubMeta("session-retry-site"),
      execute: async (_payload, session) => {
        executeCallCount += 1;
        const { sessionId } = session as unknown as { sessionId: string };
        if (sessionId === "sess-1") throw new Error("attempt 1 failed");
        return { data: { result: "ok" }, auditPayload: {} };
      },
    };

    await dispatch(retryPlugin, {}, context);

    expect(executeCallCount).toBe(2);
    expect(sessionAttempt1.getOutboundIp).toHaveBeenCalledTimes(1);
    expect(sessionAttempt2.getOutboundIp).toHaveBeenCalledTimes(1);
    expect(envelopeCallFor("session-retry-site")?.session).toEqual({
      id: "sess-2",
      provider: "browserbase",
      ip: "203.0.113.2",
      ipCapturedAt: expect.any(String),
    });
  });

  it("merges non-colliding keys added across attempts without duplicating them", async () => {
    const context = buildContext("req-retry-merge");

    mockRunWithSession.mockImplementationOnce(
      async (task: (session: { attempt: number }) => Promise<unknown>) => {
        await task({ attempt: 1 }).catch(() => undefined);
        return task({ attempt: 2 });
      }
    );

    const retryPlugin: SitePlugin<unknown, unknown> = {
      meta: stubMeta("retry-merge-site"),
      execute: async (_payload, session, context) => {
        const typedContext = context as ContextWithTelemetry;
        const { attempt } = session as unknown as { attempt: number };
        if (attempt === 1) {
          typedContext.telemetry.addJoinKeys({ firstAttemptField: "seen-once" });
          throw new Error("attempt 1 failed");
        }
        typedContext.telemetry.addJoinKeys({ secondAttemptField: "seen-once-too" });
        return { data: { result: "ok" }, auditPayload: {} };
      },
    };

    await dispatch(retryPlugin, {}, context);

    // No duplicated keys: each field appears exactly once in the final merge,
    // not once per attempt it was touched during.
    expect(envelopeCallFor("retry-merge-site")?.joinKeys).toEqual({
      firstAttemptField: "seen-once",
      secondAttemptField: "seen-once-too",
    });
  });
});

describe("dispatch — needsUserInfo short-circuits before any run-telemetry merge", () => {
  it("emits no submission envelope even though fields were attached via context.telemetry during the run", async () => {
    const context = buildContext("req-needs-info");

    const httpPlugin: SitePlugin<unknown, unknown> = {
      meta: stubMeta("needs-info-site"),
      execute: async () => {
        throw new Error("execute() should not be called — executeHttp handles this plugin");
      },
      executeHttp: async (_payload, ctx) => {
        (ctx as ContextWithTelemetry).telemetry.addJoinKeys({
          discoveredMidRun: "should-not-surface",
        });
        return {
          data: {
            verified: false,
            needsUserInfo: true,
            missingFields: [] as { field: string; question: string }[],
            requiresOtp: true,
          },
        };
      },
    };

    const result = await dispatch(httpPlugin, {}, context);

    expect((result.data as { needsUserInfo: boolean }).needsUserInfo).toBe(true);
    expect(mockCaptureSubmissionEnvelope).not.toHaveBeenCalled();
    expect(mockFireTrackingClick).not.toHaveBeenCalled();
    expect(mockCaptureBeaconEvent).not.toHaveBeenCalled();
    // The field really was attached — proves the short-circuit skips the
    // merge/emit step deliberately, not because nothing was ever collected.
    expect(context.telemetry.snapshot().joinKeys).toEqual({
      discoveredMidRun: "should-not-surface",
    });
  });
});
