import Fastify from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod/v4";

import authPlugin from "@/api/plugins/auth";
import errorHandlerPlugin from "@/api/plugins/error-handler";
import type { AppConfig } from "@/config";
import { getLogger } from "@/lib/logging";
import { registerRoutes } from "@/plugins/loader";
import {
  HttpBotChallengeError,
  HttpRateLimitError,
  HttpSchemaError,
  HttpServerError,
  HttpUrlLockedError,
} from "@/scraper/errors";
import type { SitePlugin } from "@/site-plugin";

const mockCaptureSubmissionEnvelope = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockGetCachedResponse = vi.hoisted(() =>
  vi.fn().mockReturnValue({ value: undefined, key: "test-key" })
);
const mockGetOrCreateInFlight = vi.hoisted(() =>
  vi.fn().mockImplementation((_key: string, producer: () => Promise<unknown>) => producer())
);
const mockRunWithSession = vi.hoisted(() =>
  vi.fn().mockImplementation((task: (s: null) => Promise<unknown>) => task(null))
);

// Stub runWithSession so the fallback branch doesn't need a real browser session.
vi.mock("@/scraper/pool", () => ({
  runWithSession: mockRunWithSession,
}));

vi.mock("@/lib/telemetry/submission-capture", () => ({
  captureSubmissionEnvelope: mockCaptureSubmissionEnvelope,
}));

vi.mock("@/lib/telemetry/beacon-capture", () => ({
  captureBeaconEvent: vi.fn().mockResolvedValue(undefined),
  createBeaconOutcomeRecorder: vi.fn(() => vi.fn().mockResolvedValue(undefined)),
}));

// Force every call a cache miss so executeHttp is actually invoked.
vi.mock("@/cache/response-cache", () => ({
  getCachedResponse: mockGetCachedResponse,
  getOrCreateInFlight: mockGetOrCreateInFlight,
}));

/** Fixture error carrying a site-reported error code, to verify it is echoed onto the telemetry record. */
class CodedHttpSchemaError extends HttpSchemaError {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.code = code;
  }
}

describe("dispatch — hotPathError telemetry recorded before browser fallback engages", () => {
  const cfgStub = { scraper: { siteBaseUrls: {} } } as unknown as AppConfig;
  const preservedEnv = {
    DEV_BYPASS_AUTH: process.env.DEV_BYPASS_AUTH,
    NODE_ENV: process.env.NODE_ENV,
  };

  beforeEach(() => {
    process.env.DEV_BYPASS_AUTH = "true";
    process.env.NODE_ENV = "test";
    mockCaptureSubmissionEnvelope.mockResolvedValue(undefined);
    mockGetCachedResponse.mockReturnValue({ value: undefined, key: "test-key" });
    mockGetOrCreateInFlight.mockImplementation((_key: string, producer: () => Promise<unknown>) =>
      producer()
    );
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
      loggerInstance: getLogger({ name: "loader-hot-path-error-telemetry-test" }),
      genReqId: () => "req-hot-path-error-fixed",
    });
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    await app.register(errorHandlerPlugin);
    await app.register(authPlugin);
    await registerRoutes(app, cfgStub, [plugin]);
    await app.ready();
    return app;
  }

  it.each([
    ["HttpSchemaError", () => new HttpSchemaError("schema mismatch")],
    ["HttpBotChallengeError", () => new HttpBotChallengeError("bot challenge encountered")],
    ["HttpServerError", () => new HttpServerError("http 5xx server error")],
  ])(
    "records hotPathError (name/message) on the submission envelope call that engages the browser fallback for %s",
    async (errorName, makeError) => {
      const siteId = `hot-path-error-${errorName.toLowerCase()}`;
      const plugin: SitePlugin<unknown, unknown> = {
        meta: {
          siteId,
          displayName: "Hot Path Error Test",
          bodySchema: z.object({}),
          responseSchema: z.unknown(),
        },
        executeHttp: async () => {
          throw makeError();
        },
        execute: async () => ({ data: { ok: true, path: "browser" } }),
      };
      const app = await buildAppWithPlugin(plugin);

      const response = await app.inject({
        method: "POST",
        url: `/v1/${siteId}/run`,
        payload: {},
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body) as { path: string };
      expect(body.path).toBe("browser");

      expect(mockCaptureSubmissionEnvelope).toHaveBeenCalledTimes(1);
      expect(mockCaptureSubmissionEnvelope).toHaveBeenCalledWith(
        expect.objectContaining({
          siteId,
          status: "submitted",
          hotPathError: { name: errorName, message: expect.any(String), code: null },
        })
      );

      await app.close();
    }
  );

  it("echoes a site-reported error code onto the hotPathError telemetry field when the hot-path throw carries one", async () => {
    const siteId = "hot-path-error-coded";
    const plugin: SitePlugin<unknown, unknown> = {
      meta: {
        siteId,
        displayName: "Hot Path Coded Error Test",
        bodySchema: z.object({}),
        responseSchema: z.unknown(),
      },
      executeHttp: async () => {
        throw new CodedHttpSchemaError("schema mismatch: missing field", "SITE_ERR_4471");
      },
      execute: async () => ({ data: { ok: true, path: "browser" } }),
    };
    const app = await buildAppWithPlugin(plugin);

    const response = await app.inject({
      method: "POST",
      url: `/v1/${siteId}/run`,
      payload: {},
    });

    expect(response.statusCode).toBe(200);

    expect(mockCaptureSubmissionEnvelope).toHaveBeenCalledTimes(1);
    expect(mockCaptureSubmissionEnvelope).toHaveBeenCalledWith(
      expect.objectContaining({
        siteId,
        status: "submitted",
        hotPathError: {
          name: "CodedHttpSchemaError",
          message: "schema mismatch: missing field",
          code: "SITE_ERR_4471",
        },
      })
    );

    await app.close();
  });

  it("records hotPathError on the error-status envelope call when the browser fallback itself then fails", async () => {
    const siteId = "hot-path-error-fallback-fails";
    const plugin: SitePlugin<unknown, unknown> = {
      meta: {
        siteId,
        displayName: "Hot Path Fallback Fails Test",
        bodySchema: z.object({}),
        responseSchema: z.unknown(),
      },
      executeHttp: async () => {
        throw new HttpSchemaError("schema mismatch");
      },
      execute: async () => {
        throw new Error("browser fallback also failed");
      },
    };
    const app = await buildAppWithPlugin(plugin);

    const response = await app.inject({
      method: "POST",
      url: `/v1/${siteId}/run`,
      payload: {},
    });

    expect(response.statusCode).toBeGreaterThanOrEqual(500);

    expect(mockCaptureSubmissionEnvelope).toHaveBeenCalledTimes(1);
    expect(mockCaptureSubmissionEnvelope).toHaveBeenCalledWith(
      expect.objectContaining({
        siteId,
        status: "error",
        hotPathError: { name: "HttpSchemaError", message: "schema mismatch", code: null },
      })
    );

    await app.close();
  });
});

describe("dispatch — hotPathError telemetry recorded before a not-falling-back rethrow", () => {
  const cfgStub = { scraper: { siteBaseUrls: {} } } as unknown as AppConfig;
  const preservedEnv = {
    DEV_BYPASS_AUTH: process.env.DEV_BYPASS_AUTH,
    NODE_ENV: process.env.NODE_ENV,
  };

  beforeEach(() => {
    process.env.DEV_BYPASS_AUTH = "true";
    process.env.NODE_ENV = "test";
    mockCaptureSubmissionEnvelope.mockResolvedValue(undefined);
    mockGetCachedResponse.mockReturnValue({ value: undefined, key: "test-key" });
    mockGetOrCreateInFlight.mockImplementation((_key: string, producer: () => Promise<unknown>) =>
      producer()
    );
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
      loggerInstance: getLogger({ name: "loader-hot-path-error-rethrow-test" }),
      genReqId: () => "req-hot-path-error-rethrow",
    });
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    await app.register(errorHandlerPlugin);
    await app.register(authPlugin);
    await registerRoutes(app, cfgStub, [plugin]);
    await app.ready();
    return app;
  }

  it.each([
    ["HttpRateLimitError", () => new HttpRateLimitError("http 429 rate limit exceeded"), 429],
    ["HttpUrlLockedError", () => new HttpUrlLockedError("requisition url locked"), 429],
  ])(
    "records hotPathError on the error-status envelope call and rethrows without invoking execute for %s",
    async (errorName, makeError, expectedStatus) => {
      const siteId = `hot-path-error-rethrow-${errorName.toLowerCase()}`;
      const executeSpy = vi.fn().mockResolvedValue({ data: { ok: true, path: "browser" } });
      const plugin: SitePlugin<unknown, unknown> = {
        meta: {
          siteId,
          displayName: "Hot Path Error Rethrow Test",
          bodySchema: z.object({}),
          responseSchema: z.unknown(),
        },
        executeHttp: async () => {
          throw makeError();
        },
        execute: executeSpy,
      };
      const app = await buildAppWithPlugin(plugin);

      const response = await app.inject({
        method: "POST",
        url: `/v1/${siteId}/run`,
        payload: {},
      });

      expect(response.statusCode).toBe(expectedStatus);
      expect(executeSpy).not.toHaveBeenCalled();

      expect(mockCaptureSubmissionEnvelope).toHaveBeenCalledTimes(1);
      expect(mockCaptureSubmissionEnvelope).toHaveBeenCalledWith(
        expect.objectContaining({
          siteId,
          status: "error",
          errorMessage: expect.any(String),
          hotPathError: { name: errorName, message: expect.any(String), code: null },
        })
      );

      await app.close();
    }
  );
});
