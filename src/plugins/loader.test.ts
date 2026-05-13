import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CaptchaEncounteredError, ScrapeFailureError, ThrottledRequestError } from "@/api/errors";
import { dispatch } from "@/plugins/loader";
import {
  CaptchaError,
  HttpBotChallengeError,
  HttpRateLimitError,
  HttpSchemaError,
  HttpServerError,
  SelectorFailureError,
} from "@/scraper/errors";
import { resetMetrics } from "@/scraper/metrics";
import type { SitePlugin, SitePluginContext } from "@/site-plugin";

// vi.hoisted runs before vi.mock factories — required so these references
// are available when the factory closures execute.
const mockCreate = vi.hoisted(() => vi.fn().mockResolvedValue({ id: "stub-id" }));
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

const mockRunWithSession = vi.hoisted(() =>
  vi.fn().mockImplementation((task: (s: null) => Promise<unknown>) => task(null))
);

// Stub runWithSession to invoke the task synchronously with a null session so
// tests don't need a real Steel session or pool setup.
vi.mock("@/scraper/pool", () => ({
  runWithSession: mockRunWithSession,
}));

// Stub prisma so tests don't need a live DB. siteSubmission.create must be
// a mock we can inspect to verify audit writes happened (and in the right order).
vi.mock("@/lib/db/client", () => ({
  prisma: {
    siteSubmission: { create: mockCreate },
    $disconnect: vi.fn().mockResolvedValue(undefined),
  },
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
};

describe("dispatch", () => {
  beforeEach(() => {
    mockCreate.mockResolvedValue({ id: "stub-id" });
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

  it("writes a SiteSubmission row with status=submitted and correct siteId on success", async () => {
    await dispatch(stubPlugin, {}, stubContext);
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "submitted", siteId: "test-site" }),
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

  it("writes the error SiteSubmission row BEFORE throwing", async () => {
    mockPluginExecute.mockRejectedValueOnce(new CaptchaError("captcha hit"));

    try {
      await dispatch(stubPlugin, {}, stubContext);
    } catch {
      // expected — we only care that create was called
    }

    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "error", siteId: "test-site" }),
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
    mockCreate.mockResolvedValue({ id: "stub-id" });
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
    expect(mockRunWithSession).toHaveBeenCalledWith(expect.any(Function), { onRetry }, undefined);
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
    mockCreate.mockResolvedValue({ id: "stub-id" });
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
    mockCreate.mockResolvedValue({ id: "stub-id" });
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
