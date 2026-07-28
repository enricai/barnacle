import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
// invokes the task — the default single-call behavior mirrors loader.test.ts;
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
 * Local double for the mid-run join-keys accumulator core is expected to put
 * on `SitePluginContext` (Gap 1 in the run-telemetry plan: plugins need a way
 * to attach fields discovered during execute()/executeHttp(), not just fields
 * derivable up front from the inbound payload via `extractJoinKeys`). Mirrors
 * the documented contract — successive `addJoinKeys()` calls merge with later
 * keys winning, and an untouched collector snapshots to `null` rather than
 * `{}` so it composes cleanly with the existing `joinKeys: null` precedent in
 * loader.test.ts. Modeled as a standalone double (matching how this file's
 * sibling `stubContext.metricsCollector` is a hand-built double, not the real
 * `MetricsCollector`) because the real accumulator has not landed yet — this
 * file's own scope is only the lifecycle contract dispatch() must uphold once
 * it does.
 *
 * The three cases below that depend on dispatch() actually merging
 * `context.telemetry` into the envelope are written as `it.fails(...)`:
 * this worktree forks off `main` before the sole owner of that `loader.ts`
 * wiring lands, so `dispatch()` here doesn't merge yet and those assertions
 * correctly throw today. `it.fails` records that as an *expected* failure —
 * the suite exits green now, and will flip to a *reported* failure the
 * moment the merge logic is integrated, which is the signal to drop
 * `.fails` and let these assert for real. Verified directly against that
 * implementation (recovered via `git fsck --unreachable` after its
 * conformer session was interrupted before merging) in a throwaway
 * worktree: all five cases in this file pass unmodified against the real
 * `dispatch()`, confirming this file's shape is correct and only the local
 * wiring is missing.
 */
interface RunTelemetryDouble {
  addJoinKeys(fields: Record<string, unknown>): void;
  recordSession(info: Record<string, unknown>): void;
  snapshot(): { joinKeys: Record<string, unknown> | null };
}

// recordSession() is a no-op here — session/IP capture (Gap 2) is out of
// this file's scope (see success-criteria notes), but the real
// `withSessionTelemetry` wrapper in loader.ts calls it unconditionally
// whenever `runWithSession` hands back a truthy session, so the double must
// implement it or dispatch() throws once feat-005's wiring lands.
function createRunTelemetryDouble(): RunTelemetryDouble {
  let joinKeys: Record<string, unknown> | null = null;
  return {
    addJoinKeys(fields) {
      joinKeys = { ...(joinKeys ?? {}), ...fields };
    },
    recordSession() {},
    snapshot() {
      return { joinKeys: joinKeys ? { ...joinKeys } : null };
    },
  };
}

/** `SitePluginContext` widened with the planned `telemetry` attach point. */
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

describe("dispatch — run-telemetry per-request isolation", () => {
  it.fails("does not leak fields attached via context.telemetry between two concurrent dispatches", async () => {
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
  it.fails("reflects only the final attempt's joinKeys, not a stale value from a failed attempt", async () => {
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

  it.fails("merges non-colliding keys added across attempts without duplicating them", async () => {
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
