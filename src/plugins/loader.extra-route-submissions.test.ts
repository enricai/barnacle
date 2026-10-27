import Fastify from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod/v4";

import authPlugin from "@/api/plugins/auth";
import errorHandlerPlugin from "@/api/plugins/error-handler";
import type { AppConfig } from "@/config";
import { getLogger } from "@/lib/logging";
import { registerRoutes } from "@/plugins/loader";
import type { SitePlugin, SitePluginExtraRoute } from "@/site-plugin";

// vi.hoisted runs before vi.mock factories, so the reference exists when the factory runs.
const mockCaptureSubmissionEnvelope = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock("@/lib/telemetry/submission-capture", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/telemetry/submission-capture")>()),
  captureSubmissionEnvelope: mockCaptureSubmissionEnvelope,
}));

/**
 * An extra route that can submit (a plugin's `/resume`) bypasses dispatch(), so
 * without `submits: true` its submits never reach the submissions sink — the
 * gap that hid every resumed application from the submission telemetry.
 */
describe("registerRoutes — submission telemetry for extra routes that submit", () => {
  const cfgStub = { scraper: { siteBaseUrls: {} } } as unknown as AppConfig;
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

  async function appWith(
    handler: SitePluginExtraRoute["handler"],
    submits: boolean | undefined,
    extractJoinKeys?: SitePlugin<unknown, unknown>["extractJoinKeys"]
  ): Promise<Parameters<typeof registerRoutes>[0]> {
    const plugin: SitePlugin<unknown, unknown> = {
      ...(extractJoinKeys ? { extractJoinKeys } : {}),
      meta: {
        siteId: "resume-site",
        displayName: "resume-site",
        bodySchema: z.object({}),
        responseSchema: z.unknown(),
        extraRoutes: [{ method: "post", path: "/v1/resume-site/resume", handler, submits }],
      },
      execute: vi.fn(),
    };
    const app = Fastify({
      loggerInstance: getLogger({ name: "loader-extra-route-submissions-test" }),
      genReqId: () => "req-resume-fixed",
    });
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    await app.register(errorHandlerPlugin);
    await app.register(authPlugin);
    await registerRoutes(app, cfgStub, [plugin]);
    await app.ready();
    return app;
  }

  const post = (app: Parameters<typeof registerRoutes>[0]) =>
    app.inject({ method: "POST", url: "/v1/resume-site/resume", payload: { Email: "n@x.com" } });

  it("records a verified result as submitted, with the request body as the inbound payload", async () => {
    const app = await appWith(async () => ({ verified: true, confirmation: "SUB1" }), true);

    const response = await post(app);

    expect(response.statusCode).toBe(200);
    expect(mockCaptureSubmissionEnvelope).toHaveBeenCalledTimes(1);
    expect(mockCaptureSubmissionEnvelope).toHaveBeenCalledWith(
      expect.objectContaining({
        siteId: "resume-site",
        requestId: "req-resume-fixed",
        status: "submitted",
        auditPayload: { verified: true, confirmation: "SUB1" },
        errorMessage: null,
        inboundPayload: { Email: "n@x.com" },
      })
    );
    await app.close();
  });

  it("records an unverified result as submitted too, as dispatch() records /run", async () => {
    const app = await appWith(async () => ({ verified: false, reason: "not qualified" }), true);

    const response = await post(app);

    expect(response.statusCode).toBe(200);
    expect(mockCaptureSubmissionEnvelope).toHaveBeenCalledTimes(1);
    expect(mockCaptureSubmissionEnvelope).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "submitted",
        auditPayload: { verified: false, reason: "not qualified" },
      })
    );
    await app.close();
  });

  it("records nothing for a needsUserInfo hand-off, which is not a finished run", async () => {
    const app = await appWith(
      async () => ({ verified: false, needsUserInfo: true, missingFields: [] }),
      true
    );

    const response = await post(app);

    expect(response.statusCode).toBe(200);
    expect(mockCaptureSubmissionEnvelope).not.toHaveBeenCalled();
    await app.close();
  });

  it("records a throwing handler as error and still returns the error", async () => {
    const app = await appWith(async () => {
      throw new Error("resume failed");
    }, true);

    const response = await post(app);

    expect(response.statusCode).toBe(500);
    expect(mockCaptureSubmissionEnvelope).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "error",
        errorMessage: "resume failed",
        auditPayload: null,
      })
    );
    await app.close();
  });

  it("records nothing for a route that doesn't declare submits", async () => {
    const app = await appWith(async () => ({ verified: true }), undefined);

    await post(app);

    expect(mockCaptureSubmissionEnvelope).not.toHaveBeenCalled();
    await app.close();
  });

  it("keeps a submitted reply when the plugin's join-key extraction throws", async () => {
    const app = await appWith(
      async () => ({ verified: true }),
      true,
      () => {
        throw new Error("bad body shape");
      }
    );

    const response = await post(app);

    expect(response.statusCode).toBe(200);
    expect(mockCaptureSubmissionEnvelope).not.toHaveBeenCalled();
    await app.close();
  });

  it("keeps the reply when the sink rejects", async () => {
    mockCaptureSubmissionEnvelope.mockRejectedValueOnce(new Error("sink unavailable"));
    const app = await appWith(async () => ({ verified: true }), true);

    const response = await post(app);

    expect(response.statusCode).toBe(200);
    await app.close();
  });
});
