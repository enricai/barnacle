/**
 * Route-boundary test: a config-only plugin (built from a JSON manifest with no
 * per-site TypeScript) registers a working POST /v1/{siteId}/run and returns the
 * standard success envelope. The browser session is mocked via runWithSession so
 * the test exercises registration + dispatch, not a real Stagehand flow.
 */
import Fastify from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import authPlugin from "@/api/plugins/auth";
import errorHandlerPlugin from "@/api/plugins/error-handler";
import type { AppConfig } from "@/config";
import { getLogger } from "@/lib/logging";
import { buildConfigPlugin } from "@/plugins/config-plugin";
import { registerRoutes } from "@/plugins/loader";

const mockCaptureSubmissionEnvelope = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockRunWithSession = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ data: { confirmationId: "CONF-123" } })
);

vi.mock("@/lib/telemetry/submission-capture", () => ({
  captureSubmissionEnvelope: mockCaptureSubmissionEnvelope,
}));

vi.mock("@/scraper/pool", () => ({
  runWithSession: mockRunWithSession,
}));

vi.mock("@/lib/tracking-click", () => ({
  fireTrackingClick: vi.fn(),
}));

vi.mock("@/scraper/metrics", () => ({
  recordHotPathSuccess: vi.fn(),
  recordFallbackActivation: vi.fn(),
  recordRateLimitRejection: vi.fn(),
  recordHotPathLatency: vi.fn(),
  allMetrics: vi.fn().mockReturnValue({}),
  resetMetrics: vi.fn(),
}));

const MANIFEST = {
  apiVersion: "barnacle.dev/v1",
  kind: "SitePlugin",
  metadata: { siteId: "route-config", displayName: "Route Config" },
  spec: {
    defaultBaseUrl: "https://apply.example",
    request: {
      type: "object",
      required: ["FirstName", "Email"],
      properties: { FirstName: { type: "string" }, Email: { type: "string" } },
    },
    response: { type: "object", properties: { confirmationId: { type: "string" } } },
    flow: {
      steps: ["click apply", { step: "fill First Name with {{ .request.FirstName }}" }],
    },
    extract: {
      instruction: "extract the confirmation id",
      schema: { type: "object", properties: { confirmationId: { type: "string" } } },
    },
  },
};

describe("POST /v1/{siteId}/run — config-only plugin", () => {
  const cfgStub = {
    scraper: { siteBaseUrls: {} },
    plugins: { specifiers: [], strict: false, baseDir: process.cwd() },
  } as unknown as AppConfig;
  const preservedEnv = {
    DEV_BYPASS_AUTH: process.env.DEV_BYPASS_AUTH,
    NODE_ENV: process.env.NODE_ENV,
  };

  beforeEach(() => {
    process.env.DEV_BYPASS_AUTH = "true";
    process.env.NODE_ENV = "test";
  });

  afterEach(() => {
    if (preservedEnv.DEV_BYPASS_AUTH === undefined) delete process.env.DEV_BYPASS_AUTH;
    else process.env.DEV_BYPASS_AUTH = preservedEnv.DEV_BYPASS_AUTH;
    if (preservedEnv.NODE_ENV === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = preservedEnv.NODE_ENV;
    vi.clearAllMocks();
  });

  it("registers a route and returns the success envelope for a valid body", async () => {
    const plugin = await buildConfigPlugin(MANIFEST);

    const app = Fastify({ loggerInstance: getLogger({ name: "config-plugin-route-test" }) });
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    await app.register(errorHandlerPlugin);
    await app.register(authPlugin);
    await registerRoutes(app, cfgStub, [plugin]);
    await app.ready();

    const response = await app.inject({
      method: "POST",
      url: "/v1/route-config/run",
      payload: { FirstName: "Jane", Email: "jane@example.com" },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<{ status: { httpStatus: string }; confirmationId?: string }>();
    expect(body.status).toBeDefined();
    expect(body.confirmationId).toBe("CONF-123");
    expect(mockRunWithSession).toHaveBeenCalledOnce();

    await app.close();
  });

  it("rejects a body that fails the manifest's request schema", async () => {
    const plugin = await buildConfigPlugin(MANIFEST);

    const app = Fastify({ loggerInstance: getLogger({ name: "config-plugin-route-test" }) });
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    await app.register(errorHandlerPlugin);
    await app.register(authPlugin);
    await registerRoutes(app, cfgStub, [plugin]);
    await app.ready();

    const response = await app.inject({
      method: "POST",
      url: "/v1/route-config/run",
      payload: { FirstName: "Jane" },
    });

    expect(response.statusCode).toBe(400);
    expect(mockRunWithSession).not.toHaveBeenCalled();

    await app.close();
  });
});
