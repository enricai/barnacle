import Fastify from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod/v4";

import {
  CaptchaEncounteredError,
  EmptyResultsApiError,
  ScrapeFailureError,
  ThrottledRequestError,
  UrlLockedError,
} from "@/api/errors";
import authPlugin from "@/api/plugins/auth";
import errorHandlerPlugin from "@/api/plugins/error-handler";
import type { AppConfig } from "@/config";
import { getLogger } from "@/lib/logging";
import { multipartJsonObject } from "@/lib/zod-multipart";
import { BUILTIN_SITE_PLUGINS } from "@/plugins/discover";
import { dispatch, registerRoutes, SITE_PLUGINS } from "@/plugins/loader";
import {
  CaptchaError,
  EmptyResultsError,
  HttpBotChallengeError,
  HttpRateLimitError,
  HttpSchemaError,
  HttpServerError,
  HttpUrlLockedError,
  SelectorFailureError,
} from "@/scraper/errors";
import { resetMetrics } from "@/scraper/metrics";
import type { SitePlugin, SitePluginContext } from "@/site-plugin";

// vi.hoisted runs before vi.mock factories — required so these references
// are available when the factory closures execute.
const mockCaptureSubmissionEnvelope = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockPluginExecute = vi.hoisted(() =>
  vi.fn().mockResolvedValue({
    data: { result: "ok" },
    auditPayload: { redacted: true },
  })
);
const mockRecordHotPathSuccess = vi.hoisted(() => vi.fn());
const mockRecordFallbackActivation = vi.hoisted(() => vi.fn());
const mockRecordRateLimitRejection = vi.hoisted(() => vi.fn());
const mockRecordHotPathLatency = vi.hoisted(() => vi.fn());
const mockGetCachedResponse = vi.hoisted(() =>
  vi.fn().mockReturnValue({ value: undefined, key: "test-key" })
);
const mockGetOrCreateInFlight = vi.hoisted(() =>
  vi.fn().mockImplementation((_key: string, producer: () => Promise<unknown>) => producer())
);
const mockFireTrackingClick = vi.hoisted(() => vi.fn());
const mockCaptureBeaconEvent = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockRecordDdFailure = vi.hoisted(() => vi.fn());

const mockRunWithSession = vi.hoisted(() =>
  vi.fn().mockImplementation((task: (s: null) => Promise<unknown>) => task(null))
);

// Stub runWithSession to invoke the task synchronously with a null session so
// tests don't need a real Steel session or pool setup.
vi.mock("@/scraper/pool", () => ({
  runWithSession: mockRunWithSession,
}));

// Stub captureSubmissionEnvelope so tests don't touch the real NDJSON sink.
// We assert on its call args to verify dispatch emits envelopes on both
// success and error branches.
vi.mock("@/lib/telemetry/submission-capture", () => ({
  captureSubmissionEnvelope: mockCaptureSubmissionEnvelope,
}));

vi.mock("@/scraper/metrics", () => ({
  recordHotPathSuccess: mockRecordHotPathSuccess,
  recordFallbackActivation: mockRecordFallbackActivation,
  recordRateLimitRejection: mockRecordRateLimitRejection,
  recordHotPathLatency: mockRecordHotPathLatency,
  allMetrics: vi.fn().mockReturnValue({}),
  resetMetrics: vi.fn(),
}));

vi.mock("@/cache/response-cache", () => ({
  getCachedResponse: mockGetCachedResponse,
  getOrCreateInFlight: mockGetOrCreateInFlight,
}));

vi.mock("@/lib/tracking-click", () => ({
  fireTrackingClick: mockFireTrackingClick,
}));

// createBeaconOutcomeRecorder's mock double replicates the real factory's
// binding + never-throw wrapping around captureBeaconEvent, so tests can
// assert on mockCaptureBeaconEvent's fully-merged call args regardless of
// which layer (dispatch's own emitBeaconSafely, or a plugin's bound
// recordBeaconOutcome) produced them. It is re-implemented here rather than
// vi.importActual'd because the production closure over captureBeaconEvent is
// a same-module reference, not an import — the actual module would bypass
// mockCaptureBeaconEvent entirely and hit the real sink.
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

vi.mock("@/lib/dd-metrics", () => ({
  recordDdAttempt: vi.fn(),
  recordDdSuccess: vi.fn(),
  recordDdFailure: mockRecordDdFailure,
  recordDdDuration: vi.fn(),
  recordDdFallback: vi.fn(),
  recordDdRateLimit: vi.fn(),
}));

const stubPlugin: SitePlugin<unknown, unknown> = {
  meta: {
    siteId: "test-site",
    displayName: "Test Site",
    bodySchema: {} as never,
    responseSchema: {} as never,
  },
  execute: mockPluginExecute,
};

const stubContext: SitePluginContext = {
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
      path: "http" as const,
      steps: [],
      attemptCount: 1,
      startedAt: "",
      endedAt: "",
      recordedAt: "",
    })),
  } as unknown as SitePluginContext["metricsCollector"],
  recordBeaconOutcome: vi.fn().mockResolvedValue(undefined),
};

describe("dispatch", () => {
  beforeEach(() => {
    mockCaptureSubmissionEnvelope.mockResolvedValue(undefined);
    mockPluginExecute.mockResolvedValue({
      data: { result: "ok" },
      auditPayload: { redacted: true },
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("calls plugin.execute() once with the passed payload and context", async () => {
    const payload = { field: "value" };
    await dispatch(stubPlugin, payload, stubContext);
    expect(mockPluginExecute).toHaveBeenCalledTimes(1);
    expect(mockPluginExecute).toHaveBeenCalledWith(payload, null, stubContext);
  });

  it("emits a submission envelope with status=submitted, siteId, and requestId on success", async () => {
    const payload = { jobId: "job-1" };
    await dispatch(stubPlugin, payload, stubContext);
    expect(mockCaptureSubmissionEnvelope).toHaveBeenCalledTimes(1);
    expect(mockCaptureSubmissionEnvelope).toHaveBeenCalledWith(
      expect.objectContaining({
        siteId: "test-site",
        requestId: "req-test-123",
        status: "submitted",
        inboundPayload: payload,
        auditPayload: { redacted: true },
        errorMessage: null,
      })
    );
  });

  it("emits null joinKeys on the success envelope when the plugin declares no extractJoinKeys", async () => {
    const payload = {
      TrackingUrl: "https://click.acme.example/t/abc?vivclid=123&empId=emp9&jid=job9",
    };
    await dispatch(stubPlugin, payload, stubContext);
    expect(mockCaptureSubmissionEnvelope).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "submitted",
        joinKeys: null,
      })
    );
  });

  it("emits the plugin's extractJoinKeys result on the success envelope", async () => {
    const joinKeysPlugin: SitePlugin<unknown, unknown> = {
      ...stubPlugin,
      extractJoinKeys: (payload) => {
        const { TrackingUrl } = payload as { TrackingUrl?: string };
        return TrackingUrl ? { vivclid: "123", jobReference: "emp9_job9" } : null;
      },
    };
    const payload = {
      TrackingUrl: "https://click.acme.example/t/abc?vivclid=123&empId=emp9&jid=job9",
    };
    await dispatch(joinKeysPlugin, payload, stubContext);
    expect(mockCaptureSubmissionEnvelope).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "submitted",
        joinKeys: { vivclid: "123", jobReference: "emp9_job9" },
      })
    );
  });

  it("returns the SitePluginResult from execute() on success", async () => {
    const result = await dispatch(stubPlugin, {}, stubContext);
    expect(result.data).toEqual({ result: "ok" });
  });

  it("throws CaptchaEncounteredError (not CaptchaError) when execute throws CaptchaError", async () => {
    mockPluginExecute.mockRejectedValueOnce(new CaptchaError("captcha hit"));
    await expect(dispatch(stubPlugin, {}, stubContext)).rejects.toBeInstanceOf(
      CaptchaEncounteredError
    );
  });

  it("throws EmptyResultsApiError when execute throws EmptyResultsError", async () => {
    mockPluginExecute.mockRejectedValueOnce(new EmptyResultsError("no results found"));
    await expect(dispatch(stubPlugin, {}, stubContext)).rejects.toBeInstanceOf(
      EmptyResultsApiError
    );
  });

  it("resolves normally when the envelope sink write fails (best-effort swallow)", async () => {
    mockCaptureSubmissionEnvelope.mockRejectedValueOnce(new Error("disk full"));
    const result = await dispatch(stubPlugin, {}, stubContext);
    expect(result.data).toEqual({ result: "ok" });
  });

  it("throws ScrapeFailureError when execute throws a non-CaptchaError ScraperError subclass", async () => {
    mockPluginExecute.mockRejectedValueOnce(new SelectorFailureError("selector failed"));
    await expect(dispatch(stubPlugin, {}, stubContext)).rejects.toBeInstanceOf(ScrapeFailureError);
  });

  it("re-throws the original Error unchanged when execute throws a plain Error", async () => {
    const plainErr = new Error("unexpected");
    mockPluginExecute.mockRejectedValueOnce(plainErr);

    let caught: unknown;
    try {
      await dispatch(stubPlugin, {}, stubContext);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBe(plainErr);
  });

  it("emits an error envelope with the original error message BEFORE throwing", async () => {
    mockPluginExecute.mockRejectedValueOnce(new CaptchaError("captcha hit"));

    try {
      await dispatch(stubPlugin, {}, stubContext);
    } catch {
      // expected — we only care that the envelope was emitted
    }

    expect(mockCaptureSubmissionEnvelope).toHaveBeenCalledTimes(1);
    expect(mockCaptureSubmissionEnvelope).toHaveBeenCalledWith(
      expect.objectContaining({
        siteId: "test-site",
        requestId: "req-test-123",
        status: "error",
        errorMessage: "captcha hit",
        auditPayload: null,
      })
    );
  });

  it("emits the plugin's extractJoinKeys result on the error envelope", async () => {
    mockPluginExecute.mockRejectedValueOnce(new CaptchaError("captcha hit"));
    const joinKeysPlugin: SitePlugin<unknown, unknown> = {
      ...stubPlugin,
      extractJoinKeys: () => ({ vivclid: "999", jobReference: "emp1_job1" }),
    };
    const payload = {
      TrackingUrl: "https://click.acme.example/t/abc?vivclid=999&empId=emp1&jid=job1",
    };

    try {
      await dispatch(joinKeysPlugin, payload, stubContext);
    } catch {
      // expected — we only care that the envelope was emitted
    }

    expect(mockCaptureSubmissionEnvelope).toHaveBeenCalledWith(
      expect.objectContaining({
        siteId: "test-site",
        status: "error",
        joinKeys: { vivclid: "999", jobReference: "emp1_job1" },
      })
    );
  });

  it("emits null joinKeys on the error envelope when the plugin declares no extractJoinKeys", async () => {
    mockPluginExecute.mockRejectedValueOnce(new CaptchaError("captcha hit"));

    try {
      await dispatch(stubPlugin, {}, stubContext);
    } catch {
      // expected — we only care that the envelope was emitted
    }

    expect(mockCaptureSubmissionEnvelope).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "error",
        joinKeys: null,
      })
    );
  });
});

describe("dispatch — executeHttp hot-path branches", () => {
  const mockHttpExecute = vi.fn();

  const httpPlugin: SitePlugin<unknown, unknown> = {
    meta: {
      siteId: "http-site",
      displayName: "HTTP Site",
      bodySchema: {} as never,
      responseSchema: {} as never,
    },
    execute: mockPluginExecute,
    executeHttp: mockHttpExecute,
  };

  beforeEach(() => {
    mockCaptureSubmissionEnvelope.mockResolvedValue(undefined);
    mockPluginExecute.mockResolvedValue({ data: { result: "ok" } });
    mockHttpExecute.mockResolvedValue({ data: { result: "hot" } });
  });

  afterEach(() => {
    vi.clearAllMocks();
    resetMetrics();
  });

  it("calls executeHttp and records hot-path success when it resolves", async () => {
    const result = await dispatch(httpPlugin, {}, stubContext);
    expect(mockHttpExecute).toHaveBeenCalledTimes(1);
    expect(mockPluginExecute).not.toHaveBeenCalled();
    expect(mockRecordHotPathSuccess).toHaveBeenCalledWith("http-site");
    expect(result.data).toEqual({ result: "hot" });
  });

  it("falls back to execute() and records fallback on HttpSchemaError", async () => {
    mockHttpExecute.mockRejectedValueOnce(new HttpSchemaError("schema mismatch"));
    const result = await dispatch(httpPlugin, {}, stubContext);
    expect(mockPluginExecute).toHaveBeenCalledTimes(1);
    expect(mockRecordFallbackActivation).toHaveBeenCalledWith("http-site");
    expect(mockRecordHotPathSuccess).not.toHaveBeenCalled();
    expect(result.data).toEqual({ result: "ok" });
  });

  it("falls back to execute() and records fallback on HttpBotChallengeError", async () => {
    mockHttpExecute.mockRejectedValueOnce(new HttpBotChallengeError("403 bot wall"));
    await dispatch(httpPlugin, {}, stubContext);
    expect(mockPluginExecute).toHaveBeenCalledTimes(1);
    expect(mockRecordFallbackActivation).toHaveBeenCalledWith("http-site");
  });

  it("records rate-limit rejection and throws ThrottledRequestError on HttpRateLimitError", async () => {
    mockHttpExecute.mockRejectedValueOnce(new HttpRateLimitError("429 rate limit"));
    await expect(dispatch(httpPlugin, {}, stubContext)).rejects.toBeInstanceOf(
      ThrottledRequestError
    );
    expect(mockRecordRateLimitRejection).toHaveBeenCalledWith("http-site");
    expect(mockPluginExecute).not.toHaveBeenCalled();
    expect(mockRecordFallbackActivation).not.toHaveBeenCalled();
  });

  it("throws UrlLockedError and does NOT invoke browser execute() on HttpUrlLockedError", async () => {
    mockHttpExecute.mockRejectedValueOnce(new HttpUrlLockedError("URL_LOCKED"));
    await expect(dispatch(httpPlugin, {}, stubContext)).rejects.toBeInstanceOf(UrlLockedError);
    expect(mockPluginExecute).not.toHaveBeenCalled();
    expect(mockRecordFallbackActivation).not.toHaveBeenCalled();
    expect(mockRecordRateLimitRejection).not.toHaveBeenCalled();
  });

  it("throws EmptyResultsApiError and does NOT invoke browser execute() on EmptyResultsError", async () => {
    mockHttpExecute.mockRejectedValueOnce(
      new EmptyResultsError("ats-a http-flow: job_expired — The job is no longer available.")
    );
    await expect(dispatch(httpPlugin, {}, stubContext)).rejects.toBeInstanceOf(
      EmptyResultsApiError
    );
    expect(mockPluginExecute).not.toHaveBeenCalled();
    expect(mockRecordFallbackActivation).not.toHaveBeenCalled();
  });

  it("records dispatch.failure with error_type=url_locked (not rate_limit) on HttpUrlLockedError", async () => {
    mockHttpExecute.mockRejectedValueOnce(new HttpUrlLockedError("URL_LOCKED"));
    await expect(dispatch(httpPlugin, {}, stubContext)).rejects.toBeInstanceOf(UrlLockedError);
    expect(mockRecordDdFailure).toHaveBeenCalledWith(
      expect.objectContaining({ error_type: "url_locked" })
    );
    expect(mockRecordDdFailure).not.toHaveBeenCalledWith(
      expect.objectContaining({ error_type: "rate_limit" })
    );
  });

  it("re-throws unrelated errors without fallback or metrics", async () => {
    const plainErr = new Error("network timeout");
    mockHttpExecute.mockRejectedValueOnce(plainErr);
    let caught: unknown;
    try {
      await dispatch(httpPlugin, {}, stubContext);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBe(plainErr);
    expect(mockPluginExecute).not.toHaveBeenCalled();
    expect(mockRecordFallbackActivation).not.toHaveBeenCalled();
    expect(mockRecordRateLimitRejection).not.toHaveBeenCalled();
    expect(mockRecordHotPathSuccess).not.toHaveBeenCalled();
  });

  it("falls back to execute() and records fallback on HttpServerError (5xx)", async () => {
    mockHttpExecute.mockRejectedValueOnce(new HttpServerError("http 503 from https://example.com"));
    const result = await dispatch(httpPlugin, {}, stubContext);
    expect(mockPluginExecute).toHaveBeenCalledTimes(1);
    expect(mockRecordFallbackActivation).toHaveBeenCalledWith("http-site");
    expect(mockRecordHotPathSuccess).not.toHaveBeenCalled();
    expect(result.data).toEqual({ result: "ok" });
  });

  it("forwards plugin.onRetry to runWithSession when plugin defines it", async () => {
    const onRetry = vi.fn();
    const pluginWithRetry: SitePlugin<unknown, unknown> = {
      ...httpPlugin,
      meta: { ...httpPlugin.meta, siteId: "retry-site" },
      executeHttp: undefined,
      onRetry,
    };
    await dispatch(pluginWithRetry, {}, stubContext);
    expect(mockRunWithSession).toHaveBeenCalledWith(
      expect.any(Function),
      { onRetry, maxAttempts: undefined },
      undefined,
      {
        advancedStealth: undefined,
      }
    );
  });

  it("forwards plugin.meta.maxAttempts to runWithSession on the no-http/forceFallback path", async () => {
    const onRetry = vi.fn();
    const pluginWithMaxAttempts: SitePlugin<unknown, unknown> = {
      ...httpPlugin,
      meta: { ...httpPlugin.meta, siteId: "max-attempts-site", maxAttempts: 1 },
      executeHttp: undefined,
      onRetry,
    };
    await dispatch(pluginWithMaxAttempts, {}, stubContext);
    expect(mockRunWithSession).toHaveBeenCalledWith(
      expect.any(Function),
      { onRetry, maxAttempts: 1 },
      undefined,
      {
        advancedStealth: undefined,
      }
    );
  });

  it("forwards plugin.meta.maxAttempts to runWithSession on the http-fallback path", async () => {
    const onRetry = vi.fn();
    mockHttpExecute.mockRejectedValueOnce(new HttpServerError("http 503 from https://example.com"));
    const pluginWithMaxAttempts: SitePlugin<unknown, unknown> = {
      ...httpPlugin,
      meta: { ...httpPlugin.meta, siteId: "max-attempts-fallback-site", maxAttempts: 1 },
      onRetry,
    };
    await dispatch(pluginWithMaxAttempts, {}, stubContext);
    expect(mockRunWithSession).toHaveBeenCalledWith(
      expect.any(Function),
      { onRetry, maxAttempts: 1 },
      undefined,
      {
        advancedStealth: undefined,
      }
    );
  });

  it("forwards Browserbase session params from plugin metadata", async () => {
    const pluginWithBrowserbaseParams: SitePlugin<unknown, unknown> = {
      ...httpPlugin,
      meta: {
        ...httpPlugin.meta,
        siteId: "browserbase-params-site",
        browserbaseSessionCreateParams: { timeout: 300 },
      },
      executeHttp: undefined,
    };

    await dispatch(pluginWithBrowserbaseParams, {}, stubContext);

    expect(mockRunWithSession).toHaveBeenCalledWith(
      expect.any(Function),
      { onRetry: undefined, maxAttempts: undefined },
      undefined,
      {
        advancedStealth: undefined,
        browserbaseSessionCreateParams: { timeout: 300 },
      }
    );
  });
});

describe("dispatch — cache integration", () => {
  const mockHttpExecute = vi.fn();

  const httpPlugin: SitePlugin<unknown, unknown> = {
    meta: {
      siteId: "http-site",
      displayName: "HTTP Site",
      bodySchema: {} as never,
      responseSchema: {} as never,
    },
    execute: mockPluginExecute,
    executeHttp: mockHttpExecute,
  };

  beforeEach(() => {
    mockCaptureSubmissionEnvelope.mockResolvedValue(undefined);
    mockPluginExecute.mockResolvedValue({ data: { result: "browser" } });
    mockHttpExecute.mockResolvedValue({ data: { result: "hot" } });
    mockGetCachedResponse.mockReturnValue({ value: undefined, key: "test-key" });
    mockGetOrCreateInFlight.mockImplementation((_key: string, producer: () => Promise<unknown>) =>
      producer()
    );
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns cached value without calling executeHttp on a cache hit", async () => {
    const cachedResult = { data: { result: "from-cache" } };
    mockGetCachedResponse.mockReturnValue({ value: cachedResult, key: "test-key" });
    const result = await dispatch(httpPlugin, {}, stubContext);
    expect(result.data).toEqual({ result: "from-cache" });
    expect(mockHttpExecute).not.toHaveBeenCalled();
    expect(mockRecordHotPathSuccess).toHaveBeenCalledWith("http-site");
  });

  it("does not record latency on a cache hit", async () => {
    const cachedResult = { data: { result: "from-cache" } };
    mockGetCachedResponse.mockReturnValue({ value: cachedResult, key: "test-key" });
    await dispatch(httpPlugin, {}, stubContext);
    expect(mockRecordHotPathLatency).not.toHaveBeenCalled();
  });

  it("calls executeHttp via getOrCreateInFlight on a cache miss", async () => {
    const result = await dispatch(httpPlugin, {}, stubContext);
    expect(mockGetOrCreateInFlight).toHaveBeenCalledTimes(1);
    expect(mockHttpExecute).toHaveBeenCalledTimes(1);
    expect(result.data).toEqual({ result: "hot" });
    expect(mockRecordHotPathSuccess).toHaveBeenCalledWith("http-site");
  });

  it("records latency on a cache miss", async () => {
    await dispatch(httpPlugin, {}, stubContext);
    expect(mockRecordHotPathLatency).toHaveBeenCalledTimes(1);
    expect(mockRecordHotPathLatency).toHaveBeenCalledWith("http-site", expect.any(Number));
  });

  it("falls back to browser path when getOrCreateInFlight throws HttpSchemaError", async () => {
    mockGetOrCreateInFlight.mockRejectedValueOnce(new HttpSchemaError("drift"));
    await dispatch(httpPlugin, {}, stubContext);
    expect(mockPluginExecute).toHaveBeenCalledTimes(1);
    expect(mockRecordFallbackActivation).toHaveBeenCalledWith("http-site");
  });
});

describe("dispatch — tracking click", () => {
  beforeEach(() => {
    mockCaptureSubmissionEnvelope.mockResolvedValue(undefined);
    mockPluginExecute.mockResolvedValue({
      data: { result: "ok" },
      auditPayload: { redacted: true },
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("calls fireTrackingClick with the URL, siteId, and joinKeys when payload contains TrackingUrl", async () => {
    const payload = {
      TrackingUrl: "https://click.acme.example/t/abc?vivclid=123&empId=emp9&jid=job9",
    };
    await dispatch(stubPlugin, payload, stubContext);
    expect(mockFireTrackingClick).toHaveBeenCalledOnce();
    expect(mockFireTrackingClick).toHaveBeenCalledWith(
      "https://click.acme.example/t/abc?vivclid=123&empId=emp9&jid=job9",
      "test-site",
      { requestId: "req-test-123", joinKeys: null }
    );
  });

  it("does not call fireTrackingClick when the plugin declares extractJoinKeys (it manages its own tracking)", async () => {
    const joinKeysPlugin: SitePlugin<unknown, unknown> = {
      ...stubPlugin,
      extractJoinKeys: () => ({ vivclid: "123" }),
    };
    const payload = {
      TrackingUrl: "https://click.acme.example/t/abc?vivclid=123&empId=emp9&jid=job9",
    };
    await dispatch(joinKeysPlugin, payload, stubContext);
    expect(mockFireTrackingClick).not.toHaveBeenCalled();
  });

  it("preserves the real TrackingUrl on the skipped beacon record when a plugin with extractJoinKeys delegates tracking", async () => {
    const joinKeysPlugin: SitePlugin<unknown, unknown> = {
      ...stubPlugin,
      extractJoinKeys: () => ({ vivclid: "123" }),
    };
    const trackingUrl = "https://click.acme.example/t/abc?vivclid=123&empId=emp9&jid=job9";
    await dispatch(joinKeysPlugin, { TrackingUrl: trackingUrl }, stubContext);
    expect(mockFireTrackingClick).not.toHaveBeenCalled();
    expect(mockCaptureBeaconEvent).toHaveBeenCalledOnce();
    expect(mockCaptureBeaconEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: "req-test-123",
        siteId: "test-site",
        joinKeys: { vivclid: "123" },
        beaconStatus: "skipped",
        trackingUrl,
      })
    );
  });

  it("does not call fireTrackingClick when TrackingUrl is absent", async () => {
    await dispatch(stubPlugin, {}, stubContext);
    expect(mockFireTrackingClick).not.toHaveBeenCalled();
  });

  it("does not call fireTrackingClick when TrackingUrl is an empty string", async () => {
    await dispatch(stubPlugin, { TrackingUrl: "" }, stubContext);
    expect(mockFireTrackingClick).not.toHaveBeenCalled();
  });

  it("does not call fireTrackingClick on dispatch failure", async () => {
    mockPluginExecute.mockRejectedValueOnce(new CaptchaError("captcha hit"));
    try {
      await dispatch(stubPlugin, { TrackingUrl: "https://click.acme.example/t/abc" }, stubContext);
    } catch {
      // expected
    }
    expect(mockFireTrackingClick).not.toHaveBeenCalled();
  });

  it("emits a skipped beacon record when a successful submit has no TrackingUrl", async () => {
    const payload = { jobId: "job-1" };
    await dispatch(stubPlugin, payload, stubContext);
    expect(mockCaptureBeaconEvent).toHaveBeenCalledOnce();
    expect(mockCaptureBeaconEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: "req-test-123",
        siteId: "test-site",
        joinKeys: null,
        beaconStatus: "skipped",
        trackingUrl: null,
      })
    );
  });

  it("emits a skipped beacon record when a successful submit has an empty-string TrackingUrl", async () => {
    await dispatch(stubPlugin, { TrackingUrl: "" }, stubContext);
    expect(mockCaptureBeaconEvent).toHaveBeenCalledOnce();
    expect(mockCaptureBeaconEvent).toHaveBeenCalledWith(
      expect.objectContaining({ beaconStatus: "skipped", trackingUrl: null })
    );
  });

  it("does not emit a skipped beacon record when the payload has a TrackingUrl", async () => {
    const payload = {
      TrackingUrl: "https://click.acme.example/t/abc?vivclid=123&empId=emp9&jid=job9",
    };
    await dispatch(stubPlugin, payload, stubContext);
    expect(mockFireTrackingClick).toHaveBeenCalledOnce();
    expect(mockCaptureBeaconEvent).not.toHaveBeenCalled();
  });

  it("does not emit a skipped beacon record on dispatch failure", async () => {
    mockPluginExecute.mockRejectedValueOnce(new CaptchaError("captcha hit"));
    try {
      await dispatch(stubPlugin, {}, stubContext);
    } catch {
      // expected
    }
    expect(mockCaptureBeaconEvent).not.toHaveBeenCalled();
  });

  it("resolves normally when the skipped beacon sink write fails (best-effort swallow)", async () => {
    mockCaptureBeaconEvent.mockRejectedValueOnce(new Error("disk full"));
    const result = await dispatch(stubPlugin, {}, stubContext);
    expect(result.data).toEqual({ result: "ok" });
  });
});

describe("dispatch — forceFallback option", () => {
  const mockHttpExecute = vi.fn();

  const httpPlugin: SitePlugin<unknown, unknown> = {
    meta: {
      siteId: "http-site",
      displayName: "HTTP Site",
      bodySchema: {} as never,
      responseSchema: {} as never,
    },
    execute: mockPluginExecute,
    executeHttp: mockHttpExecute,
  };

  beforeEach(() => {
    mockCaptureSubmissionEnvelope.mockResolvedValue(undefined);
    mockPluginExecute.mockResolvedValue({ data: { result: "browser" } });
    mockHttpExecute.mockResolvedValue({ data: { result: "hot" } });
    mockGetCachedResponse.mockReturnValue({ value: undefined, key: "test-key" });
    mockGetOrCreateInFlight.mockImplementation((_key: string, producer: () => Promise<unknown>) =>
      producer()
    );
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("skips executeHttp, calls execute() directly, and records fallback when forceFallback=true", async () => {
    const result = await dispatch(httpPlugin, {}, stubContext, { forceFallback: true });
    expect(mockHttpExecute).not.toHaveBeenCalled();
    expect(mockPluginExecute).toHaveBeenCalledTimes(1);
    expect(result.data).toEqual({ result: "browser" });
    expect(mockRecordFallbackActivation).toHaveBeenCalledWith("http-site");
  });

  it("uses executeHttp normally and does not record fallback when forceFallback is false", async () => {
    const result = await dispatch(httpPlugin, {}, stubContext, { forceFallback: false });
    expect(mockHttpExecute).toHaveBeenCalledTimes(1);
    expect(mockPluginExecute).not.toHaveBeenCalled();
    expect(result.data).toEqual({ result: "hot" });
    expect(mockRecordFallbackActivation).not.toHaveBeenCalled();
  });

  it("uses executeHttp normally when options is omitted", async () => {
    const result = await dispatch(httpPlugin, {}, stubContext);
    expect(mockHttpExecute).toHaveBeenCalledTimes(1);
    expect(result.data).toEqual({ result: "hot" });
  });

  it("records fallback activation even when execute() throws with forceFallback=true", async () => {
    mockPluginExecute.mockRejectedValueOnce(new Error("browser crash"));
    try {
      await dispatch(httpPlugin, {}, stubContext, { forceFallback: true });
    } catch {
      // expected — we only care that recordFallbackActivation was called
    }
    expect(mockRecordFallbackActivation).toHaveBeenCalledWith("http-site");
  });
});

/**
 * Covers the wire-to-payload boundary for multipart-flagged plugins. The hot
 * path was verified live against a real ATS at ship time; these tests guard
 * against silent regressions in the registration logic (e.g. someone removing
 * the `attachFieldsToBody: "keyValues"` option, or moving the
 * `@fastify/multipart` register call after the route loop).
 */
describe("registerRoutes — multipart flag", () => {
  // Minimal AppConfig satisfying registerRoutes' only field access: cfg.scraper.siteBaseUrls.
  // Cast to AppConfig so the rest of the (deep) shape stays unmocked.
  const cfgStub = { scraper: { siteBaseUrls: {} } } as unknown as AppConfig;
  const preservedEnv = {
    DEV_BYPASS_AUTH: process.env.DEV_BYPASS_AUTH,
    NODE_ENV: process.env.NODE_ENV,
  };

  beforeEach(() => {
    process.env.DEV_BYPASS_AUTH = "true";
    process.env.NODE_ENV = "test";
    // dispatch() emits a submission envelope via captureSubmissionEnvelope;
    // the module-scoped mock swallows it so tests don't touch the NDJSON sink.
    mockCaptureSubmissionEnvelope.mockResolvedValue(undefined);
  });

  afterEach(() => {
    if (preservedEnv.DEV_BYPASS_AUTH === undefined) delete process.env.DEV_BYPASS_AUTH;
    else process.env.DEV_BYPASS_AUTH = preservedEnv.DEV_BYPASS_AUTH;
    if (preservedEnv.NODE_ENV === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = preservedEnv.NODE_ENV;
    vi.clearAllMocks();
  });

  // Return type mirrors registerRoutes' app parameter so the FastifyInstance
  // generic (custom Logger, etc.) lines up — `FastifyInstance` without
  // generics defaults to FastifyBaseLogger, which doesn't have errorWithStack.
  async function buildAppWithPlugin(
    plugin: SitePlugin<unknown, unknown>
  ): Promise<Parameters<typeof registerRoutes>[0]> {
    // loggerInstance carries the project's custom Logger (pino + errorWithStack)
    // so the resulting FastifyInstance generic matches registerRoutes' signature.
    const app = Fastify({ loggerInstance: getLogger({ name: "loader-test" }) });
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    await app.register(errorHandlerPlugin);
    await app.register(authPlugin);
    await registerRoutes(app, cfgStub, [plugin]);
    await app.ready();
    return app;
  }

  it("parses multipart text + file parts into payload when meta.multipart=true", async () => {
    const capturedPayload = vi.fn();
    const multipartPlugin: SitePlugin<unknown, unknown> = {
      meta: {
        siteId: "mp-test",
        displayName: "Multipart Test",
        bodySchema: z.object({
          Greeting: z.string(),
          Resume: z.instanceof(Buffer),
        }),
        responseSchema: z.unknown(),
        multipart: true,
      },
      execute: vi.fn(),
      executeHttp: async (payload) => {
        capturedPayload(payload);
        return { data: { ok: true } };
      },
    };

    const app = await buildAppWithPlugin(multipartPlugin);

    // Build multipart/form-data body by hand: light-my-request's payload type
    // is `string | object | Buffer | ReadableStream` — no native FormData
    // support — so we hand-craft the wire bytes with a fixed boundary.
    const boundary = "----barnacleTestBoundary";
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\n`),
      Buffer.from(`Content-Disposition: form-data; name="Greeting"\r\n\r\n`),
      Buffer.from(`hello\r\n`),
      Buffer.from(`--${boundary}\r\n`),
      Buffer.from(
        `Content-Disposition: form-data; name="Resume"; filename="r.pdf"\r\n` +
          `Content-Type: application/pdf\r\n\r\n`
      ),
      Buffer.from("PDF-BYTES"),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);

    const response = await app.inject({
      method: "POST",
      url: "/v1/mp-test/run",
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: body,
    });

    expect(response.statusCode).toBe(200);
    expect(capturedPayload).toHaveBeenCalledTimes(1);
    const received = capturedPayload.mock.calls[0]?.[0] as { Greeting: string; Resume: Buffer };
    expect(received.Greeting).toBe("hello");
    expect(Buffer.isBuffer(received.Resume)).toBe(true);
    expect(received.Resume.toString()).toBe("PDF-BYTES");

    await app.close();
  });

  it("keeps JSON parsing on routes whose plugin does not set meta.multipart", async () => {
    const capturedPayload = vi.fn();
    const jsonPlugin: SitePlugin<unknown, unknown> = {
      meta: {
        siteId: "json-test",
        displayName: "JSON Test",
        bodySchema: z.object({ Field: z.string() }),
        responseSchema: z.unknown(),
      },
      execute: vi.fn(),
      executeHttp: async (payload) => {
        capturedPayload(payload);
        return { data: { ok: true } };
      },
    };

    const app = await buildAppWithPlugin(jsonPlugin);

    const response = await app.inject({
      method: "POST",
      url: "/v1/json-test/run",
      payload: { Field: "value" },
    });

    expect(response.statusCode).toBe(200);
    expect(capturedPayload).toHaveBeenCalledWith({ Field: "value" });

    await app.close();
  });
});

describe("registerRoutes — x-barnacle-execution header", () => {
  const cfgStub = { scraper: { siteBaseUrls: {} } } as unknown as AppConfig;
  const preservedEnv = {
    DEV_BYPASS_AUTH: process.env.DEV_BYPASS_AUTH,
    NODE_ENV: process.env.NODE_ENV,
  };

  beforeEach(() => {
    process.env.DEV_BYPASS_AUTH = "true";
    process.env.NODE_ENV = "test";
    mockCaptureSubmissionEnvelope.mockResolvedValue(undefined);
  });

  afterEach(() => {
    if (preservedEnv.DEV_BYPASS_AUTH === undefined) delete process.env.DEV_BYPASS_AUTH;
    else process.env.DEV_BYPASS_AUTH = preservedEnv.DEV_BYPASS_AUTH;
    if (preservedEnv.NODE_ENV === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = preservedEnv.NODE_ENV;
    vi.clearAllMocks();
  });

  async function buildAppWithPlugin(
    plugin: SitePlugin<unknown, unknown>
  ): Promise<Parameters<typeof registerRoutes>[0]> {
    const app = Fastify({ loggerInstance: getLogger({ name: "loader-test" }) });
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    await app.register(errorHandlerPlugin);
    await app.register(authPlugin);
    await registerRoutes(app, cfgStub, [plugin]);
    await app.ready();
    return app;
  }

  // A plugin with both paths so header presence is the only variable deciding
  // which one runs.
  function dualPathPlugin(onHttp: () => void, onBrowser: () => void): SitePlugin<unknown, unknown> {
    return {
      meta: {
        siteId: "exec-test",
        displayName: "Execution Test",
        bodySchema: z.object({ Field: z.string() }),
        responseSchema: z.unknown(),
      },
      execute: async () => {
        onBrowser();
        return { data: { via: "browser" } };
      },
      executeHttp: async () => {
        onHttp();
        return { data: { via: "http" } };
      },
    };
  }

  it("routes to the browser path when x-barnacle-execution is browser", async () => {
    const onHttp = vi.fn();
    const onBrowser = vi.fn();
    const app = await buildAppWithPlugin(dualPathPlugin(onHttp, onBrowser));

    const response = await app.inject({
      method: "POST",
      url: "/v1/exec-test/run",
      headers: { "x-barnacle-execution": "browser" },
      payload: { Field: "value" },
    });

    expect(response.statusCode).toBe(200);
    expect(onBrowser).toHaveBeenCalledTimes(1);
    expect(onHttp).not.toHaveBeenCalled();

    await app.close();
  });

  it("uses the hot path when the header is absent", async () => {
    const onHttp = vi.fn();
    const onBrowser = vi.fn();
    const app = await buildAppWithPlugin(dualPathPlugin(onHttp, onBrowser));

    const response = await app.inject({
      method: "POST",
      url: "/v1/exec-test/run",
      payload: { Field: "value" },
    });

    expect(response.statusCode).toBe(200);
    expect(onHttp).toHaveBeenCalledTimes(1);
    expect(onBrowser).not.toHaveBeenCalled();

    await app.close();
  });

  it("uses the hot path when the header carries any other value", async () => {
    const onHttp = vi.fn();
    const onBrowser = vi.fn();
    const app = await buildAppWithPlugin(dualPathPlugin(onHttp, onBrowser));

    const response = await app.inject({
      method: "POST",
      url: "/v1/exec-test/run",
      headers: { "x-barnacle-execution": "hotpath" },
      payload: { Field: "value" },
    });

    expect(response.statusCode).toBe(200);
    expect(onHttp).toHaveBeenCalledTimes(1);
    expect(onBrowser).not.toHaveBeenCalled();

    await app.close();
  });
});

describe("registerRoutes — extraRoutes loop", () => {
  const cfgStub = { scraper: { siteBaseUrls: {} } } as unknown as AppConfig;
  const preservedEnv = {
    DEV_BYPASS_AUTH: process.env.DEV_BYPASS_AUTH,
    NODE_ENV: process.env.NODE_ENV,
  };

  beforeEach(() => {
    process.env.DEV_BYPASS_AUTH = "true";
    process.env.NODE_ENV = "test";
    mockCaptureSubmissionEnvelope.mockResolvedValue(undefined);
  });

  afterEach(() => {
    if (preservedEnv.DEV_BYPASS_AUTH === undefined) delete process.env.DEV_BYPASS_AUTH;
    else process.env.DEV_BYPASS_AUTH = preservedEnv.DEV_BYPASS_AUTH;
    if (preservedEnv.NODE_ENV === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = preservedEnv.NODE_ENV;
    vi.clearAllMocks();
  });

  async function buildAppWithPlugin(
    plugin: SitePlugin<unknown, unknown>
  ): Promise<Parameters<typeof registerRoutes>[0]> {
    const app = Fastify({ loggerInstance: getLogger({ name: "loader-extra-routes-test" }) });
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    await app.register(errorHandlerPlugin);
    await app.register(authPlugin);
    await registerRoutes(app, cfgStub, [plugin]);
    await app.ready();
    return app;
  }

  it("registers an extra route and returns an enveloped response by default", async () => {
    const extraHandler = vi.fn().mockResolvedValue({ token: "abc123" });
    const plugin: SitePlugin<unknown, unknown> = {
      meta: {
        siteId: "extra-test",
        displayName: "Extra Test",
        bodySchema: z.object({ q: z.string() }),
        responseSchema: z.unknown(),
        extraRoutes: [
          {
            method: "post",
            path: "/v1/extra-test/action",
            bodySchema: z.object({ input: z.string() }),
            handler: extraHandler,
          },
        ],
      },
      execute: vi.fn(),
    };

    const app = await buildAppWithPlugin(plugin);

    const response = await app.inject({
      method: "POST",
      url: "/v1/extra-test/action",
      payload: { input: "hello" },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as { status: { httpStatus: string }; token: string };
    expect(body.status.httpStatus).toBe("OK");
    expect(body.token).toBe("abc123");
    expect(extraHandler).toHaveBeenCalledOnce();

    await app.close();
  });

  it("sends raw (non-enveloped) response when envelope===false", async () => {
    const plugin: SitePlugin<unknown, unknown> = {
      meta: {
        siteId: "raw-test",
        displayName: "Raw Test",
        bodySchema: z.object({ q: z.string() }),
        responseSchema: z.unknown(),
        extraRoutes: [
          {
            method: "post",
            path: "/v1/raw-test/action",
            handler: async () => ({ raw: true }),
            envelope: false,
          },
        ],
      },
      execute: vi.fn(),
    };

    const app = await buildAppWithPlugin(plugin);

    const response = await app.inject({
      method: "POST",
      url: "/v1/raw-test/action",
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as { raw: boolean };
    expect(body.raw).toBe(true);
    expect((body as Record<string, unknown>).status).toBeUndefined();

    await app.close();
  });

  it("triggers multipart registration when an extraRoute declares multipart:true", async () => {
    const plugin: SitePlugin<unknown, unknown> = {
      meta: {
        siteId: "mp-extra-test",
        displayName: "Multipart Extra",
        bodySchema: z.object({ q: z.string() }),
        responseSchema: z.unknown(),
        extraRoutes: [
          {
            method: "post",
            path: "/v1/mp-extra-test/upload",
            multipart: true,
            handler: async () => ({ uploaded: true }),
          },
        ],
      },
      execute: vi.fn(),
    };

    // Merely verifies registration does not throw; multipart plugin must be
    // registered before the routes that require it.
    await expect(buildAppWithPlugin(plugin)).resolves.toBeDefined();
  });

  async function buildAppWithPlugins(
    plugins: SitePlugin<unknown, unknown>[]
  ): Promise<Parameters<typeof registerRoutes>[0]> {
    const app = Fastify({ loggerInstance: getLogger({ name: "loader-test" }) });
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    await app.register(errorHandlerPlugin);
    await app.register(authPlugin);
    await registerRoutes(app, cfgStub, plugins);
    await app.ready();
    return app;
  }

  // Regression: two plugins declaring the SAME parameterized extra route
  // (POST /v1/:siteId/resume) must not crash boot with FST_ERR_DUPLICATED_ROUTE,
  // and each site must dispatch to its own handler + body contract.
  it("registers a :siteId-shared extra route once and dispatches by siteId", async () => {
    const alphaHandler = vi.fn().mockResolvedValue({ site: "alpha" });
    const betaHandler = vi.fn().mockResolvedValue({ site: "beta" });
    const makePlugin = (
      siteId: string,
      bodySchema: z.ZodType,
      handler: typeof alphaHandler
    ): SitePlugin<unknown, unknown> => ({
      meta: {
        siteId,
        displayName: siteId,
        bodySchema: z.object({ q: z.string() }),
        responseSchema: z.unknown(),
        extraRoutes: [
          {
            method: "post",
            path: "/v1/:siteId/resume",
            bodySchema,
            paramsSchema: z.object({ siteId: z.string() }),
            handler,
          },
        ],
      },
      execute: vi.fn(),
    });

    const app = await buildAppWithPlugins([
      makePlugin("alpha", z.object({ a: z.string() }), alphaHandler),
      makePlugin("beta", z.object({ b: z.string() }), betaHandler),
    ]);

    const alphaRes = await app.inject({
      method: "POST",
      url: "/v1/alpha/resume",
      payload: { a: "hi" },
    });
    expect(alphaRes.statusCode).toBe(200);
    expect(alphaHandler).toHaveBeenCalledOnce();
    expect(betaHandler).not.toHaveBeenCalled();

    const betaRes = await app.inject({
      method: "POST",
      url: "/v1/beta/resume",
      payload: { b: "yo" },
    });
    expect(betaRes.statusCode).toBe(200);
    expect(betaHandler).toHaveBeenCalledOnce();

    // beta's body schema requires `b`; alpha's payload must fail beta's contract.
    const wrongBody = await app.inject({
      method: "POST",
      url: "/v1/beta/resume",
      payload: { a: "wrong" },
    });
    expect(wrongBody.statusCode).toBe(400);

    // Unknown siteId on the shared path is a field violation, not a crash.
    const unknownSite = await app.inject({
      method: "POST",
      url: "/v1/nope/resume",
      payload: { a: "x" },
    });
    expect(unknownSite.statusCode).toBe(400);

    await app.close();
  });

  // Regression: the PROD config — two sibling plugins both register the
  // SAME multipart :siteId/resume route. The shared-route path skips Fastify's
  // schema.body and validates via manual route.bodySchema.parse(); this asserts
  // that path still runs the schema's z.preprocess coercion (multipartJsonObject)
  // over a real multipart/form-data body and dispatches to the right plugin.
  it("dispatches a :siteId-shared MULTIPART route and coerces per-plugin body", async () => {
    const alphaPayload = vi.fn();
    const betaPayload = vi.fn();
    const makePlugin = (
      siteId: string,
      capture: typeof alphaPayload
    ): SitePlugin<unknown, unknown> => ({
      meta: {
        siteId,
        displayName: siteId,
        bodySchema: z.object({ q: z.string() }),
        responseSchema: z.unknown(),
        extraRoutes: [
          {
            method: "post",
            path: "/v1/:siteId/resume",
            multipart: true,
            // Nested object arrives as a JSON string in multipart; the schema's
            // preprocessor must decode it — the exact coercion the shared path
            // must preserve when it parses manually.
            bodySchema: z.object({
              Name: z.string(),
              Answers: multipartJsonObject(z.object({ a: z.string() })),
            }),
            paramsSchema: z.object({ siteId: z.string() }),
            handler: async (request) => {
              capture(request.body);
              return { site: siteId };
            },
          },
        ],
      },
      execute: vi.fn(),
    });

    const app = await buildAppWithPlugins([
      makePlugin("alpha", alphaPayload),
      makePlugin("beta", betaPayload),
    ]);

    const boundary = "----barnacleSharedMultipart";
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\n`),
      Buffer.from(`Content-Disposition: form-data; name="Name"\r\n\r\n`),
      Buffer.from(`Nurse Joy\r\n`),
      Buffer.from(`--${boundary}\r\n`),
      Buffer.from(`Content-Disposition: form-data; name="Answers"\r\n\r\n`),
      Buffer.from(`{"a":"yes"}\r\n`),
      Buffer.from(`--${boundary}--\r\n`),
    ]);

    const res = await app.inject({
      method: "POST",
      url: "/v1/beta/resume",
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: body,
    });

    expect(res.statusCode).toBe(200);
    expect(betaPayload).toHaveBeenCalledOnce();
    expect(alphaPayload).not.toHaveBeenCalled();
    const received = betaPayload.mock.calls[0]?.[0] as { Name: string; Answers: { a: string } };
    expect(received.Name).toBe("Nurse Joy");
    // The JSON string was decoded by the schema preprocessor through the manual
    // shared-route parse — proves coercion is preserved off the Fastify path.
    expect(received.Answers).toEqual({ a: "yes" });

    await app.close();
  });
});

describe("registerRoutes — context.recordBeaconOutcome", () => {
  const cfgStub = { scraper: { siteBaseUrls: {} } } as unknown as AppConfig;
  const preservedEnv = {
    DEV_BYPASS_AUTH: process.env.DEV_BYPASS_AUTH,
    NODE_ENV: process.env.NODE_ENV,
  };

  beforeEach(() => {
    process.env.DEV_BYPASS_AUTH = "true";
    process.env.NODE_ENV = "test";
    mockCaptureSubmissionEnvelope.mockResolvedValue(undefined);
  });

  afterEach(() => {
    if (preservedEnv.DEV_BYPASS_AUTH === undefined) delete process.env.DEV_BYPASS_AUTH;
    else process.env.DEV_BYPASS_AUTH = preservedEnv.DEV_BYPASS_AUTH;
    if (preservedEnv.NODE_ENV === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = preservedEnv.NODE_ENV;
    vi.clearAllMocks();
  });

  async function buildAppWithPlugin(
    plugin: SitePlugin<unknown, unknown>
  ): Promise<Parameters<typeof registerRoutes>[0]> {
    const app = Fastify({
      loggerInstance: getLogger({ name: "loader-recorder-test" }),
      genReqId: () => "req-recorder-fixed",
    });
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    await app.register(errorHandlerPlugin);
    await app.register(authPlugin);
    await registerRoutes(app, cfgStub, [plugin]);
    await app.ready();
    return app;
  }

  it("reaches captureBeaconEvent with this run's requestId and the plugin's siteId when execute calls context.recordBeaconOutcome, without the plugin supplying either", async () => {
    const plugin: SitePlugin<unknown, unknown> = {
      meta: {
        siteId: "recorder-run-test",
        displayName: "Recorder Run Test",
        bodySchema: z.object({}),
        responseSchema: z.unknown(),
      },
      execute: async (_payload, _session, context) => {
        await context.recordBeaconOutcome({ beaconStatus: "fired", joinKeys: { k: 1 } });
        return { data: { ok: true } };
      },
    };
    const app = await buildAppWithPlugin(plugin);

    const response = await app.inject({
      method: "POST",
      url: "/v1/recorder-run-test/run",
      payload: {},
    });

    expect(response.statusCode).toBe(200);
    expect(mockCaptureBeaconEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: "req-recorder-fixed",
        siteId: "recorder-run-test",
        joinKeys: { k: 1 },
        beaconStatus: "fired",
      })
    );

    await app.close();
  });

  it("does not fail the route when the recorder's underlying capture rejects — the route still returns 200 with the plugin's data", async () => {
    mockCaptureBeaconEvent.mockRejectedValueOnce(new Error("sink unavailable"));
    const plugin: SitePlugin<unknown, unknown> = {
      meta: {
        siteId: "recorder-reject-test",
        displayName: "Recorder Reject Test",
        bodySchema: z.object({}),
        responseSchema: z.unknown(),
      },
      execute: async (_payload, _session, context) => {
        await context.recordBeaconOutcome({ beaconStatus: "failed", joinKeys: { k: 2 } });
        return { data: { ok: true } };
      },
    };
    const app = await buildAppWithPlugin(plugin);

    const response = await app.inject({
      method: "POST",
      url: "/v1/recorder-reject-test/run",
      payload: {},
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as { ok: boolean };
    expect(body.ok).toBe(true);

    await app.close();
  });

  it("is present on the context built for an extra route, bound to that request's requestId and the owning plugin's siteId", async () => {
    const extraHandler = vi.fn().mockImplementation(async (_request, context) => {
      await context.recordBeaconOutcome({ beaconStatus: "fired", joinKeys: { k: 3 } });
      return { done: true };
    });
    const plugin: SitePlugin<unknown, unknown> = {
      meta: {
        siteId: "recorder-extra-test",
        displayName: "Recorder Extra Test",
        bodySchema: z.object({}),
        responseSchema: z.unknown(),
        extraRoutes: [
          {
            method: "post",
            path: "/v1/recorder-extra-test/action",
            handler: extraHandler,
          },
        ],
      },
      execute: vi.fn(),
    };
    const app = await buildAppWithPlugin(plugin);

    const response = await app.inject({
      method: "POST",
      url: "/v1/recorder-extra-test/action",
      payload: {},
    });

    expect(response.statusCode).toBe(200);
    expect(mockCaptureBeaconEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: "req-recorder-fixed",
        siteId: "recorder-extra-test",
        joinKeys: { k: 3 },
        beaconStatus: "fired",
      })
    );

    await app.close();
  });

  it("writes both the automatic 'skipped' write and the plugin's own 'fired' write for the same requestId when a plugin declares extractJoinKeys and also calls context.recordBeaconOutcome", async () => {
    const trackingUrl = "https://click.acme.example/t/abc?vivclid=456";
    const plugin: SitePlugin<unknown, unknown> = {
      meta: {
        siteId: "recorder-coexist-test",
        displayName: "Recorder Coexist Test",
        bodySchema: z.object({ TrackingUrl: z.string().optional() }),
        responseSchema: z.unknown(),
      },
      extractJoinKeys: () => ({ vivclid: "456" }),
      execute: async (_payload, _session, context) => {
        await context.recordBeaconOutcome({
          beaconStatus: "fired",
          joinKeys: { vivclid: "456", jid: "job1" },
        });
        return { data: { ok: true } };
      },
    };
    const app = await buildAppWithPlugin(plugin);

    const response = await app.inject({
      method: "POST",
      url: "/v1/recorder-coexist-test/run",
      payload: { TrackingUrl: trackingUrl },
    });

    expect(response.statusCode).toBe(200);
    expect(mockCaptureBeaconEvent).toHaveBeenCalledTimes(2);
    expect(mockCaptureBeaconEvent).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        requestId: "req-recorder-fixed",
        siteId: "recorder-coexist-test",
        beaconStatus: "fired",
        joinKeys: { vivclid: "456", jid: "job1" },
      })
    );
    expect(mockCaptureBeaconEvent).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        requestId: "req-recorder-fixed",
        siteId: "recorder-coexist-test",
        beaconStatus: "skipped",
        joinKeys: { vivclid: "456" },
        trackingUrl,
      })
    );

    await app.close();
  });
});

describe("dispatch — needsUserInfo branch", () => {
  const mockHttpExecute = vi.fn();

  const httpPlugin: SitePlugin<unknown, unknown> = {
    meta: {
      siteId: "http-site",
      displayName: "HTTP Site",
      bodySchema: {} as never,
      responseSchema: {} as never,
    },
    execute: mockPluginExecute,
    executeHttp: mockHttpExecute,
  };

  const needsUserInfoResult = {
    data: {
      verified: false,
      needsUserInfo: true,
      missingFields: [] as { field: string; question: string }[],
      requiresOtp: true,
    },
  };

  beforeEach(() => {
    mockCaptureSubmissionEnvelope.mockResolvedValue(undefined);
    mockHttpExecute.mockResolvedValue(needsUserInfoResult);
    mockGetCachedResponse.mockReturnValue({ value: undefined, key: "test-key" });
    mockGetOrCreateInFlight.mockImplementation((_key: string, producer: () => Promise<unknown>) =>
      producer()
    );
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns the needsUserInfo result without emitting a submission envelope", async () => {
    const result = await dispatch(httpPlugin, {}, stubContext);
    expect((result.data as { needsUserInfo: boolean }).needsUserInfo).toBe(true);
    expect(mockCaptureSubmissionEnvelope).not.toHaveBeenCalled();
  });

  it("does not fire the tracking click when needsUserInfo is true", async () => {
    await dispatch(httpPlugin, { TrackingUrl: "https://click.example.com/t/abc" }, stubContext);
    expect(mockFireTrackingClick).not.toHaveBeenCalled();
  });

  it("returns missingFields and requiresOtp from the result", async () => {
    mockHttpExecute.mockResolvedValue({
      data: {
        verified: false,
        needsUserInfo: true,
        missingFields: [{ field: "educationLevel", question: "What is your highest education?" }],
        requiresOtp: false,
      },
    });
    const result = await dispatch(httpPlugin, {}, stubContext);
    const data = result.data as {
      needsUserInfo: boolean;
      missingFields: { field: string; question: string }[];
      requiresOtp: boolean;
    };
    expect(data.missingFields).toHaveLength(1);
    expect(data.missingFields[0]?.field).toBe("educationLevel");
    expect(data.requiresOtp).toBe(false);
  });
});

describe("SITE_PLUGINS alias", () => {
  it("is the same array reference as BUILTIN_SITE_PLUGINS from discover.ts", () => {
    expect(SITE_PLUGINS).toBe(BUILTIN_SITE_PLUGINS);
  });

  it("is empty on the engine branch — site plugins load via BARNACLE_PLUGINS", () => {
    expect(SITE_PLUGINS).toEqual([]);
  });
});
