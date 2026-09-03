import Fastify from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod/v4";

import authPlugin from "@/api/plugins/auth";
import errorHandlerPlugin from "@/api/plugins/error-handler";
import type { AppConfig } from "@/config";
import { getLogger } from "@/lib/logging";
import { registerRoutes } from "@/plugins/loader";
import { HttpBotChallengeError } from "@/scraper/errors";
import type { SitePlugin } from "@/site-plugin";

const mockCaptureSubmissionEnvelope = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockGetCachedResponse = vi.hoisted(() =>
  vi.fn().mockReturnValue({ value: undefined, key: "test-key" })
);
const mockGetOrCreateInFlight = vi.hoisted(() =>
  vi.fn().mockImplementation((_key: string, producer: () => Promise<unknown>) => producer())
);
const mockRunWithSession = vi.hoisted(() => vi.fn());

// Stub runWithSession so a would-be (but never expected) fallback into
// execute() doesn't need a real browser session or pool setup.
vi.mock("@/scraper/pool", () => ({
  runWithSession: mockRunWithSession,
}));

vi.mock("@/lib/telemetry/submission-capture", () => ({
  captureSubmissionEnvelope: mockCaptureSubmissionEnvelope,
}));

// Force every call a cache miss so executeHttp actually runs instead of
// short-circuiting on a cached response.
vi.mock("@/cache/response-cache", () => ({
  getCachedResponse: mockGetCachedResponse,
  getOrCreateInFlight: mockGetOrCreateInFlight,
}));

describe("dispatch — gate and hotPathError telemetry compose on a gated hot-path failure", () => {
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
      loggerInstance: getLogger({ name: "loader-fallback-gate-hot-path-error-integration-test" }),
      genReqId: () => "req-gate-hot-path-error-fixed",
    });
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    await app.register(errorHandlerPlugin);
    await app.register(authPlugin);
    await registerRoutes(app, cfgStub, [plugin]);
    await app.ready();
    return app;
  }

  it("records hotPathError telemetry AND never calls plugin.execute() when the gate is off for a thrown HttpBotChallengeError", async () => {
    const siteId = "gate-and-hot-path-error-test";
    const mockExecute = vi.fn();
    const plugin: SitePlugin<unknown, unknown> = {
      meta: {
        siteId,
        displayName: "Gate And Hot Path Error Test",
        bodySchema: z.object({}),
        responseSchema: z.unknown(),
        browserFallbackGate: false,
      },
      executeHttp: async () => {
        throw new HttpBotChallengeError("bot challenge encountered");
      },
      execute: mockExecute,
    };
    const app = await buildAppWithPlugin(plugin);

    const response = await app.inject({
      method: "POST",
      url: `/v1/${siteId}/run`,
      payload: {},
    });

    // Gate honored: fails fast, never cascades into the browser fallback.
    expect(mockExecute).not.toHaveBeenCalled();
    expect(mockRunWithSession).not.toHaveBeenCalled();
    expect(response.statusCode).toBeGreaterThanOrEqual(500);

    // Telemetry honored: the fail-fast exit still records hotPathError on
    // the error-status envelope call, not just today's fallback/rethrow paths.
    expect(mockCaptureSubmissionEnvelope).toHaveBeenCalledTimes(1);
    expect(mockCaptureSubmissionEnvelope).toHaveBeenCalledWith(
      expect.objectContaining({
        siteId,
        status: "error",
        hotPathError: {
          name: "HttpBotChallengeError",
          message: "bot challenge encountered",
          code: null,
        },
      })
    );

    await app.close();
  });
});
