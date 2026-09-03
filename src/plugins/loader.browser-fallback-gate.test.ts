import Fastify from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod/v4";

import authPlugin from "@/api/plugins/auth";
import errorHandlerPlugin from "@/api/plugins/error-handler";
import type { AppConfig } from "@/config";
import { getLogger } from "@/lib/logging";
import { registerRoutes } from "@/plugins/loader";
import { HttpSchemaError } from "@/scraper/errors";
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

// Stub runWithSession so an ungated fallback into execute() doesn't need a
// real Steel session or pool setup.
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

describe("dispatch — per-plugin browser-fallback gate at the route boundary", () => {
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
      loggerInstance: getLogger({ name: "loader-browser-fallback-gate-test" }),
      genReqId: () => "req-gate-fixed",
    });
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    await app.register(errorHandlerPlugin);
    await app.register(authPlugin);
    await registerRoutes(app, cfgStub, [plugin]);
    await app.ready();
    return app;
  }

  it("fails fast with the mapped scrape-failure error and never calls plugin.execute() when browserFallbackGate is false", async () => {
    const mockExecute = vi.fn();
    const plugin: SitePlugin<unknown, unknown> = {
      meta: {
        siteId: "gate-off-route-test",
        displayName: "Gate Off Route Test",
        bodySchema: z.object({}),
        responseSchema: z.unknown(),
        browserFallbackGate: false,
      },
      executeHttp: async () => {
        throw new HttpSchemaError("schema mismatch");
      },
      execute: mockExecute,
    };
    const app = await buildAppWithPlugin(plugin);

    const response = await app.inject({
      method: "POST",
      url: "/v1/gate-off-route-test/run",
      payload: {},
    });

    expect(mockExecute).not.toHaveBeenCalled();
    expect(mockRunWithSession).not.toHaveBeenCalled();
    expect(response.statusCode).toBe(500);
    const body = JSON.parse(response.body) as {
      status: { details: Array<{ code: number; message: string }> };
    };
    expect(body.status.details[0]?.code).toBe(2003);
    expect(body.status.details[0]?.message).toBe("schema mismatch");

    await app.close();
  });

  it("fails fast and never calls plugin.execute() when browserFallbackGate is a predicate returning false for the thrown error", async () => {
    const mockExecute = vi.fn();
    const gate = vi.fn().mockReturnValue(false);
    const plugin: SitePlugin<unknown, unknown> = {
      meta: {
        siteId: "gate-predicate-route-test",
        displayName: "Gate Predicate Route Test",
        bodySchema: z.object({}),
        responseSchema: z.unknown(),
        browserFallbackGate: gate,
      },
      executeHttp: async () => {
        throw new HttpSchemaError("schema mismatch");
      },
      execute: mockExecute,
    };
    const app = await buildAppWithPlugin(plugin);

    const response = await app.inject({
      method: "POST",
      url: "/v1/gate-predicate-route-test/run",
      payload: {},
    });

    expect(mockExecute).not.toHaveBeenCalled();
    expect(response.statusCode).toBe(500);
    expect(gate).toHaveBeenCalledWith(expect.any(HttpSchemaError));

    await app.close();
  });

  it("preserves the existing cascade-to-execute() behavior when the plugin declares no browserFallbackGate", async () => {
    const mockExecute = vi.fn().mockResolvedValue({ data: { ok: true, path: "browser" } });
    const plugin: SitePlugin<unknown, unknown> = {
      meta: {
        siteId: "gate-absent-route-test",
        displayName: "Gate Absent Route Test",
        bodySchema: z.object({}),
        responseSchema: z.unknown(),
      },
      executeHttp: async () => {
        throw new HttpSchemaError("schema mismatch");
      },
      execute: mockExecute,
    };
    const app = await buildAppWithPlugin(plugin);

    const response = await app.inject({
      method: "POST",
      url: "/v1/gate-absent-route-test/run",
      payload: {},
    });

    expect(mockExecute).toHaveBeenCalledTimes(1);
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as { path: string };
    expect(body.path).toBe("browser");

    await app.close();
  });
});
