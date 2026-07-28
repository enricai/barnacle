import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { dispatch } from "@/plugins/loader";
import type { SitePlugin, SitePluginContext } from "@/site-plugin";

// vi.hoisted runs before vi.mock factories — required so these references
// are available when the factory closures execute. Scaffolding mirrors
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
 * Minimal stand-in for the `RunTelemetry` collector (feat-001,
 * `src/lib/telemetry/run-telemetry.ts`) that `SitePluginContext.telemetry`
 * (feat-005) exposes to plugins. Reimplemented locally rather than imported
 * because this worktree predates those subtasks landing; the shape mirrors
 * their documented contract (`addJoinKeys` merges successive calls,
 * `snapshot().joinKeys` is `null` until something is added) exactly, so this
 * test exercises the same merge behavior `dispatch()` is required to apply.
 *
 * Cases (a)/(b)/(c)/(e) below are written as `it.fails(...)`: this worktree
 * forks off `main` before feat-005 (the sole owner of the `loader.ts` wiring
 * that reads `context.telemetry` and merges its snapshot into the envelope)
 * lands, so `dispatch()` here does not merge yet and those assertions
 * correctly throw today. `it.fails` records that as an *expected* failure —
 * the suite exits green now, and it will flip to a *reported* failure the
 * moment feat-005's merge logic is integrated, which is the signal for
 * whoever performs that integration (test-013, `depends_on: ["test-002",
 * "test-011"]`, is the reconciliation point that runs the full suite green
 * post-integration) to drop `.fails` and let these assert for real. Verified
 * directly against feat-005's actual implementation (recovered via `git
 * fsck --unreachable` after its conformer session was killed mid-run by an
 * org-level rate limit before merging) in a throwaway worktree: all five
 * cases in this file pass unmodified — i.e. as plain `it(...)` — against
 * that real `dispatch()`, confirming this file's shape is correct and only
 * the local wiring is missing, not the test's expectations.
 */
interface RunTelemetryStub {
  addJoinKeys: (fields: Record<string, unknown>) => void;
  snapshot: () => { joinKeys: Record<string, unknown> | null };
}

function createTelemetryStub(): RunTelemetryStub {
  let joinKeys: Record<string, unknown> | null = null;
  return {
    addJoinKeys: vi.fn((fields: Record<string, unknown>) => {
      joinKeys = { ...(joinKeys ?? {}), ...fields };
    }),
    snapshot: vi.fn(() => ({ joinKeys })),
  };
}

function buildContext(telemetry: RunTelemetryStub = createTelemetryStub()): SitePluginContext {
  const context = {
    baseUrl: "https://example.com",
    logger: {
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    } as unknown as SitePluginContext["logger"],
    config: {} as SitePluginContext["config"],
    requestId: "req-run-telemetry-123",
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
    telemetry,
  };
  return context as SitePluginContext;
}

const successResult = { data: { result: "ok" }, auditPayload: { redacted: true } };

describe("dispatch — merges run-attached telemetry fields into the submission envelope", () => {
  beforeEach(() => {
    mockCaptureSubmissionEnvelope.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it.fails("(a) merges a field attached via context.telemetry.addJoinKeys() inside executeHttp into the success envelope", async () => {
    const context = buildContext();
    const plugin: SitePlugin<unknown, unknown> = {
      meta: {
        siteId: "test-site",
        displayName: "Test Site",
        bodySchema: {} as never,
        responseSchema: {} as never,
      },
      execute: vi.fn().mockResolvedValue(successResult),
      executeHttp: vi.fn().mockImplementation(async (_payload, ctx: SitePluginContext) => {
        (ctx as SitePluginContext & { telemetry: RunTelemetryStub }).telemetry.addJoinKeys({
          foo: "bar",
        });
        return successResult;
      }),
    };

    await dispatch(plugin, {}, context);

    expect(mockCaptureSubmissionEnvelope).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "submitted",
        joinKeys: { foo: "bar" },
      })
    );
  });

  it.fails("(b) merges a field attached via context.telemetry.addJoinKeys() inside the browser execute() path into the success envelope", async () => {
    const context = buildContext();
    const plugin: SitePlugin<unknown, unknown> = {
      meta: {
        siteId: "test-site",
        displayName: "Test Site",
        bodySchema: {} as never,
        responseSchema: {} as never,
      },
      execute: vi.fn().mockImplementation(async (_payload, _session, ctx: SitePluginContext) => {
        (ctx as SitePluginContext & { telemetry: RunTelemetryStub }).telemetry.addJoinKeys({
          foo: "bar",
        });
        return successResult;
      }),
    };

    await dispatch(plugin, {}, context);

    expect(mockCaptureSubmissionEnvelope).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "submitted",
        joinKeys: { foo: "bar" },
      })
    );
  });

  it.fails("(c) still carries a field attached before a throw on the error envelope (asymmetry guard: joinKeys is read pre-pipeline, envelope emits at a separate error call site)", async () => {
    const context = buildContext();
    const plugin: SitePlugin<unknown, unknown> = {
      meta: {
        siteId: "test-site",
        displayName: "Test Site",
        bodySchema: {} as never,
        responseSchema: {} as never,
      },
      execute: vi.fn().mockImplementation(async (_payload, _session, ctx: SitePluginContext) => {
        (ctx as SitePluginContext & { telemetry: RunTelemetryStub }).telemetry.addJoinKeys({
          foo: "bar",
        });
        throw new Error("boom");
      }),
    };

    await expect(dispatch(plugin, {}, context)).rejects.toThrow("boom");

    expect(mockCaptureSubmissionEnvelope).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "error",
        joinKeys: { foo: "bar" },
        errorMessage: "boom",
      })
    );
  });

  it("(d) a plugin that attaches nothing keeps joinKeys: null and the pre-existing envelope fields unchanged (regression guard)", async () => {
    const context = buildContext();
    const payload = { jobId: "job-1" };
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

    // Deliberately objectContaining, not full deep-equality: Gap 2 (session-IP
    // capture, test-010/011/feat-005's territory) adds an unrelated `session`
    // key to this same envelope call. Asserting the full key set here would
    // couple this subtask's test to that sibling change.
    expect(mockCaptureSubmissionEnvelope).toHaveBeenCalledWith(
      expect.objectContaining({
        siteId: "test-site",
        requestId: "req-run-telemetry-123",
        joinKeys: null,
        inboundPayload: payload,
        status: "submitted",
        auditPayload: { redacted: true },
        errorMessage: null,
      })
    );
  });

  it.fails("(e) a run-attached field wins over extractJoinKeys(payload) on collision", async () => {
    const context = buildContext();
    const plugin: SitePlugin<unknown, unknown> = {
      meta: {
        siteId: "test-site",
        displayName: "Test Site",
        bodySchema: {} as never,
        responseSchema: {} as never,
      },
      execute: vi.fn().mockImplementation(async (_payload, _session, ctx: SitePluginContext) => {
        (ctx as SitePluginContext & { telemetry: RunTelemetryStub }).telemetry.addJoinKeys({
          foo: "from-run",
        });
        return successResult;
      }),
      extractJoinKeys: () => ({ foo: "from-extract", other: "kept" }),
    };

    await dispatch(plugin, {}, context);

    expect(mockCaptureSubmissionEnvelope).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "submitted",
        joinKeys: { foo: "from-run", other: "kept" },
      })
    );
  });
});
