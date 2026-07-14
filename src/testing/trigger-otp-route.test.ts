/**
 * Integration tests for POST /v1/:siteId/trigger-otp. Uses a self-contained
 * Fastify instance with app.inject() so no port binding is needed. triggerOtpFlow
 * is mocked at the module seam — no real Oracle HCM calls.
 */

import Fastify from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/api/errors";
import authPlugin from "@/api/plugins/auth";
import errorHandlerPlugin from "@/api/plugins/error-handler";
import { ERROR_CODES } from "@/api/schemas/common";
import type { AppConfig } from "@/config";
import { getLogger } from "@/lib/logging";
import { registerRoutes } from "@/plugins/loader";
import type { SitePlugin } from "@/site-plugin";
import { encompasshealthPlugin } from "@/sites/encompasshealth";

const mockTriggerOtpFlow = vi.hoisted(() => vi.fn().mockResolvedValue({ success: true }));

vi.mock("@/sites/encompasshealth/flows/trigger-otp-flow", () => ({
  triggerOtpFlow: mockTriggerOtpFlow,
}));

vi.mock("@/sites/encompasshealth/flows/resume-flow", () => ({
  resumeFlow: vi.fn().mockResolvedValue({ data: { verified: true } }),
}));

vi.mock("@/scraper/pool", () => ({
  runWithSession: vi.fn(),
}));

vi.mock("@/lib/telemetry/submission-capture", () => ({
  captureSubmissionEnvelope: vi.fn().mockResolvedValue(undefined),
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

const cfgStub = { scraper: { siteBaseUrls: {} } } as unknown as AppConfig;

async function buildApp(): Promise<Parameters<typeof registerRoutes>[0]> {
  const app = Fastify({ loggerInstance: getLogger({ name: "trigger-otp-route-test" }) });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(errorHandlerPlugin);
  await app.register(authPlugin);
  await registerRoutes(app, cfgStub, [encompasshealthPlugin as SitePlugin<unknown, unknown>]);
  await app.ready();
  return app;
}

const preservedEnv = {
  DEV_BYPASS_AUTH: process.env.DEV_BYPASS_AUTH,
  NODE_ENV: process.env.NODE_ENV,
};

describe("POST /v1/:siteId/trigger-otp", () => {
  beforeEach(() => {
    process.env.DEV_BYPASS_AUTH = "true";
    process.env.NODE_ENV = "test";
    mockTriggerOtpFlow.mockResolvedValue({ success: true });
  });

  afterEach(() => {
    if (preservedEnv.DEV_BYPASS_AUTH === undefined) delete process.env.DEV_BYPASS_AUTH;
    else process.env.DEV_BYPASS_AUTH = preservedEnv.DEV_BYPASS_AUTH;
    if (preservedEnv.NODE_ENV === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = preservedEnv.NODE_ENV;
    vi.clearAllMocks();
  });

  it("returns 200 with status envelope and success:true on valid request", async () => {
    const app = await buildApp();

    const response = await app.inject({
      method: "POST",
      url: "/v1/encompasshealth/trigger-otp",
      payload: { offerId: "REQ-12345", email: "nurse@example.com" },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as {
      status: { httpStatus: string; dateTime: string; details: unknown[] };
      success: boolean;
    };
    expect(body.status.httpStatus).toBe("OK");
    expect(body.status.details).toEqual([]);
    expect(body.success).toBe(true);

    await app.close();
  });

  it("calls triggerOtpFlow with email and reqNum derived from the request body", async () => {
    const app = await buildApp();

    await app.inject({
      method: "POST",
      url: "/v1/encompasshealth/trigger-otp",
      payload: { offerId: "REQ-99999", email: "candidate@example.com" },
    });

    expect(mockTriggerOtpFlow).toHaveBeenCalledOnce();
    expect(mockTriggerOtpFlow).toHaveBeenCalledWith({
      email: "candidate@example.com",
      reqNum: "REQ-99999",
    });

    await app.close();
  });

  it("returns 400 field-violation when email is missing", async () => {
    const app = await buildApp();

    const response = await app.inject({
      method: "POST",
      url: "/v1/encompasshealth/trigger-otp",
      payload: { offerId: "REQ-12345" },
    });

    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.body) as {
      status: { details: { code: number }[] };
    };
    expect(body.status.details[0]?.code).toBe(ERROR_CODES.FIELD_VIOLATION);
    expect(mockTriggerOtpFlow).not.toHaveBeenCalled();

    await app.close();
  });

  it("returns 400 field-violation when offerId is missing", async () => {
    const app = await buildApp();

    const response = await app.inject({
      method: "POST",
      url: "/v1/encompasshealth/trigger-otp",
      payload: { email: "nurse@example.com" },
    });

    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.body) as {
      status: { details: { code: number }[] };
    };
    expect(body.status.details[0]?.code).toBe(ERROR_CODES.FIELD_VIOLATION);
    expect(mockTriggerOtpFlow).not.toHaveBeenCalled();

    await app.close();
  });

  it("returns 400 field-violation when email is not a valid email address", async () => {
    const app = await buildApp();

    const response = await app.inject({
      method: "POST",
      url: "/v1/encompasshealth/trigger-otp",
      payload: { offerId: "REQ-12345", email: "not-an-email" },
    });

    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.body) as {
      status: { details: { code: number }[] };
    };
    expect(body.status.details[0]?.code).toBe(ERROR_CODES.FIELD_VIOLATION);
    expect(mockTriggerOtpFlow).not.toHaveBeenCalled();

    await app.close();
  });

  it("returns error envelope with code 2006 when triggerOtpFlow throws VERIFICATION_TRIGGER_FAILED", async () => {
    mockTriggerOtpFlow.mockRejectedValueOnce(
      new ApiError(ERROR_CODES.VERIFICATION_TRIGGER_FAILED, "oracle HCM rejected the OTP trigger")
    );

    const app = await buildApp();

    const response = await app.inject({
      method: "POST",
      url: "/v1/encompasshealth/trigger-otp",
      payload: { offerId: "REQ-12345", email: "nurse@example.com" },
    });

    expect(response.statusCode).toBe(500);
    const body = JSON.parse(response.body) as {
      status: { details: { code: number; codeDescription: string }[] };
    };
    expect(body.status.details[0]?.code).toBe(ERROR_CODES.VERIFICATION_TRIGGER_FAILED);
    expect(body.status.details[0]?.codeDescription).toBe("VERIFICATION_TRIGGER_FAILED");

    await app.close();
  });

  it("returns 401 when DEV_BYPASS_AUTH is false and no Authorization header is provided", async () => {
    process.env.DEV_BYPASS_AUTH = "false";

    const app = await buildApp();

    const response = await app.inject({
      method: "POST",
      url: "/v1/encompasshealth/trigger-otp",
      payload: { offerId: "REQ-12345", email: "nurse@example.com" },
    });

    expect(response.statusCode).toBe(401);

    await app.close();
  });
});
