import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { dispatch } from "@/plugins/loader";
import type { SitePlugin, SitePluginContext } from "@/site-plugin";

/**
 * Covers the beacon-side seam of run-attached telemetry fields: dispatch()
 * hands joinKeys to `fireTrackingClick` and to `captureBeaconEvent` on two
 * different branches (§ dispatch — tracking click), separate from the
 * submit-envelope seam covered by loader.run-telemetry.test.ts. Parallels the
 * hoisted-mock scaffolding and assertion shapes of loader.test.ts:34-101 and
 * loader.test.ts:592-630 so this file is a drop-in sibling of the existing
 * "dispatch — tracking click" suite rather than a diverging convention.
 */

const mockCaptureSubmissionEnvelope = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockRunWithSession = vi.hoisted(() =>
  vi.fn().mockImplementation((task: (s: null) => Promise<unknown>) => task(null))
);
const mockFireTrackingClick = vi.hoisted(() => vi.fn());
const mockCaptureBeaconEvent = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockGetCachedResponse = vi.hoisted(() =>
  vi.fn().mockReturnValue({ value: undefined, key: "test-key" })
);
const mockGetOrCreateInFlight = vi.hoisted(() =>
  vi.fn().mockImplementation((_key: string, producer: () => Promise<unknown>) => producer())
);

vi.mock("@/scraper/pool", () => ({
  runWithSession: mockRunWithSession,
}));

vi.mock("@/lib/telemetry/submission-capture", () => ({
  captureSubmissionEnvelope: mockCaptureSubmissionEnvelope,
}));

vi.mock("@/lib/tracking-click", () => ({
  fireTrackingClick: mockFireTrackingClick,
}));

// Re-implemented rather than vi.importActual'd for the same reason as
// loader.test.ts:90-114: createBeaconOutcomeRecorder's production closure
// over captureBeaconEvent is a same-module reference, so the real module
// would bypass mockCaptureBeaconEvent entirely.
vi.mock("@/lib/telemetry/beacon-capture", () => ({
  captureBeaconEvent: mockCaptureBeaconEvent,
  createBeaconOutcomeRecorder: vi.fn(
    (binding: { requestId: string; siteId: string }) =>
      async (input: {
        beaconStatus: string;
        joinKeys: unknown;
        trackingUrl?: string | null;
        durationMs?: number;
      }) => {
        try {
          await mockCaptureBeaconEvent({
            requestId: binding.requestId,
            siteId: binding.siteId,
            joinKeys: input.joinKeys,
            beaconStatus: input.beaconStatus,
            trackingUrl: input.trackingUrl ?? null,
            durationMs: input.durationMs ?? 0,
          });
        } catch {
          // swallow, matching the real factory's never-throw contract
        }
      }
  ),
}));

vi.mock("@/cache/response-cache", () => ({
  getCachedResponse: mockGetCachedResponse,
  getOrCreateInFlight: mockGetOrCreateInFlight,
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
 * Minimal shape of the mid-run telemetry attach point `SitePluginContext`
 * exposes (`context.telemetry`, backed by `RunTelemetry` in
 * `src/lib/telemetry/run-telemetry.ts`). Reimplemented locally rather than
 * imported so this file exercises the documented contract shape
 * independent of the real class.
 */
interface RunTelemetryStub {
  addJoinKeys: (fields: Record<string, unknown>) => void;
  snapshot: () => { joinKeys: Record<string, unknown> | null };
}

type ContextWithTelemetry = SitePluginContext & { telemetry: RunTelemetryStub };

function buildStubContext(): ContextWithTelemetry {
  const collected: Record<string, unknown> = {};
  const telemetry: RunTelemetryStub = {
    addJoinKeys: vi.fn((fields: Record<string, unknown>) => {
      Object.assign(collected, fields);
    }),
    snapshot: vi.fn(() => ({
      joinKeys: Object.keys(collected).length > 0 ? { ...collected } : null,
    })),
  };
  const base: Omit<SitePluginContext, "telemetry"> = {
    baseUrl: "https://example.com",
    logger: {
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    } as unknown as SitePluginContext["logger"],
    config: {} as SitePluginContext["config"],
    requestId: "req-test-123",
    metricsCollector: {
      startStep: vi.fn(),
      endStep: vi.fn(),
      markRetry: vi.fn(),
      finalize: vi.fn(() => ({
        totalDurationMs: 0,
        path: "browser" as const,
        steps: [],
        attemptCount: 1,
        startedAt: "",
        endedAt: "",
        recordedAt: "",
      })),
    } as unknown as SitePluginContext["metricsCollector"],
    recordBeaconOutcome: vi.fn().mockResolvedValue(undefined),
  };
  // This file's stub only implements the joinKeys half of RunTelemetry's
  // contract — session capture is out of scope here (every runWithSession
  // mock in this file hands back a null session).
  return { ...base, telemetry } as unknown as ContextWithTelemetry;
}

const TRACKING_URL = "https://click.acme.example/t/abc?clickId=123&empId=emp9&jid=job9";

/** A plugin with no `extractJoinKeys` (core owns tracking) that attaches a field mid-run. */
const attachingPlugin: SitePlugin<unknown, unknown> = {
  meta: {
    siteId: "test-site",
    displayName: "Test Site",
    bodySchema: {} as never,
    responseSchema: {} as never,
  },
  execute: vi.fn(async (_payload: unknown, _session, context: SitePluginContext) => {
    (context as ContextWithTelemetry).telemetry.addJoinKeys({ midRunField: "discovered-value" });
    return { data: { result: "ok" }, auditPayload: { redacted: true } };
  }),
};

/** A plugin that declares `extractJoinKeys` (delegates tracking) and attaches a field mid-run. */
const delegatingPlugin: SitePlugin<unknown, unknown> = {
  meta: {
    siteId: "test-site",
    displayName: "Test Site",
    bodySchema: {} as never,
    responseSchema: {} as never,
  },
  extractJoinKeys: () => ({ clickId: "123" }),
  execute: vi.fn(async (_payload: unknown, _session, context: SitePluginContext) => {
    (context as ContextWithTelemetry).telemetry.addJoinKeys({ midRunField: "discovered-value" });
    return { data: { result: "ok" }, auditPayload: { redacted: true } };
  }),
};

/**
 * A plugin with no `extractJoinKeys` (core owns tracking) whose `execute`
 * also self-records a beacon outcome via `context.recordBeaconOutcome`.
 * Regression guard for the "existing plugins are unaffected" acceptance
 * criterion: the recorder must add a line, never suppress or divert the
 * engine's own `fireTrackingClick` branch (loader.ts:320-338).
 */
const nonSelfManagingRecordingPlugin: SitePlugin<unknown, unknown> = {
  meta: {
    siteId: "test-site",
    displayName: "Test Site",
    bodySchema: {} as never,
    responseSchema: {} as never,
  },
  execute: vi.fn(async (_payload: unknown, _session, context: SitePluginContext) => {
    await context.recordBeaconOutcome({ beaconStatus: "fired", joinKeys: { clickId: "123" } });
    return { data: { result: "ok" }, auditPayload: { redacted: true } };
  }),
};

describe("dispatch — engine-fired tracking path when a non-self-managing plugin also self-records", () => {
  beforeEach(() => {
    mockCaptureSubmissionEnvelope.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("fires the engine's own tracking click exactly once, with the URL, siteId, and requestId, for a plugin with no extractJoinKeys", async () => {
    const context = buildStubContext();
    await dispatch(attachingPlugin, { TrackingUrl: TRACKING_URL }, context);

    expect(mockFireTrackingClick).toHaveBeenCalledOnce();
    // `attachingPlugin.execute` (shared with the describe block below) always
    // attaches `midRunField` via `context.telemetry.addJoinKeys` — this test
    // only cares about the URL/siteId/requestId triple, so it asserts the
    // merged joinKeys value rather than the pre-merge `null` this suite
    // predates.
    expect(mockFireTrackingClick).toHaveBeenCalledWith(TRACKING_URL, "test-site", {
      requestId: "req-test-123",
      joinKeys: { midRunField: "discovered-value" },
    });
  });

  it("still fires the tracking click exactly once and writes no automatic skipped beacon line when that plugin's execute also calls context.recordBeaconOutcome", async () => {
    const context = buildStubContext();
    await dispatch(nonSelfManagingRecordingPlugin, { TrackingUrl: TRACKING_URL }, context);

    expect(mockFireTrackingClick).toHaveBeenCalledOnce();
    expect(mockFireTrackingClick).toHaveBeenCalledWith(TRACKING_URL, "test-site", {
      requestId: "req-test-123",
      joinKeys: null,
    });
    expect(context.recordBeaconOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ beaconStatus: "fired" })
    );
    expect(mockCaptureBeaconEvent).not.toHaveBeenCalled();
  });
});

describe("dispatch — run-attached fields on the beacon/tracking-click record", () => {
  beforeEach(() => {
    mockCaptureSubmissionEnvelope.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("includes mid-run attached fields in fireTrackingClick's reconciliation context when the plugin has no extractJoinKeys", async () => {
    const context = buildStubContext();
    await dispatch(attachingPlugin, { TrackingUrl: TRACKING_URL }, context);

    expect(mockFireTrackingClick).toHaveBeenCalledOnce();
    expect(mockFireTrackingClick).toHaveBeenCalledWith(
      TRACKING_URL,
      "test-site",
      expect.objectContaining({
        requestId: "req-test-123",
        joinKeys: expect.objectContaining({ midRunField: "discovered-value" }),
      })
    );
  });

  it("emits a skipped beacon record with the merged fields, preserving trackingUrl, when the plugin declares extractJoinKeys and attaches mid-run", async () => {
    const context = buildStubContext();
    await dispatch(delegatingPlugin, { TrackingUrl: TRACKING_URL }, context);

    expect(mockFireTrackingClick).not.toHaveBeenCalled();
    expect(mockCaptureBeaconEvent).toHaveBeenCalledOnce();
    expect(mockCaptureBeaconEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: "req-test-123",
        siteId: "test-site",
        beaconStatus: "skipped",
        trackingUrl: TRACKING_URL,
        joinKeys: expect.objectContaining({
          clickId: "123",
          midRunField: "discovered-value",
        }),
      })
    );
  });
});
