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
    mockHttpExecute.mockRejectedValueOnce(new HttpUrlLockedError("ORA_URL_LOCKED"));
    await expect(dispatch(httpPlugin, {}, stubContext)).rejects.toBeInstanceOf(UrlLockedError);
    expect(mockPluginExecute).not.toHaveBeenCalled();
    expect(mockRecordFallbackActivation).not.toHaveBeenCalled();
    expect(mockRecordRateLimitRejection).not.toHaveBeenCalled();
  });

  it("records dispatch.failure with error_type=url_locked (not rate_limit) on HttpUrlLockedError", async () => {
    mockHttpExecute.mockRejectedValueOnce(new HttpUrlLockedError("ORA_URL_LOCKED"));
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
    expect(mockRunWithSession).toHaveBeenCalledWith(expect.any(Function), { onRetry }, undefined, {
      advancedStealth: undefined,
    });
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

  it("calls fireTrackingClick with the URL and siteId when payload contains TrackingUrl", async () => {
    const payload = { TrackingUrl: "https://click.appcast.io/t/abc?vivclid=123" };
    await dispatch(stubPlugin, payload, stubContext);
    expect(mockFireTrackingClick).toHaveBeenCalledOnce();
    expect(mockFireTrackingClick).toHaveBeenCalledWith(
      "https://click.appcast.io/t/abc?vivclid=123",
      "test-site"
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
      await dispatch(stubPlugin, { TrackingUrl: "https://click.appcast.io/t/abc" }, stubContext);
    } catch {
      // expected
    }
    expect(mockFireTrackingClick).not.toHaveBeenCalled();
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
 * path was verified live against ClearCompany at ship time; these tests guard
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
