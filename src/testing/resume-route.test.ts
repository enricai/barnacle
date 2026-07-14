/**
 * Route integration tests for POST /v1/:siteId/resume.
 * Self-contained: spins up a full Fastify app via app.inject() without port
 * binding. resumeFlow is mocked at the module seam so no real Oracle HCM
 * traffic or Steel sessions are needed.
 */

import Fastify from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { InvalidOtpError } from "@/api/errors";
import authPlugin from "@/api/plugins/auth";
import errorHandlerPlugin from "@/api/plugins/error-handler";
import { ERROR_CODES } from "@/api/schemas/common";
import type { AppConfig } from "@/config";
import { getLogger } from "@/lib/logging";
import { registerRoutes } from "@/plugins/loader";
import type { SitePlugin } from "@/site-plugin";
import { encompasshealthPlugin } from "@/sites/encompasshealth";
import { TEST_ANSWERS } from "@/testing/answers-fixture";

const mockResumeFlow = vi.hoisted(() => vi.fn().mockResolvedValue({ data: { verified: true } }));

vi.mock("@/sites/encompasshealth/flows/resume-flow", () => ({
  resumeFlow: mockResumeFlow,
}));

// triggerOtpFlow is imported transitively by loader.ts — stub it so the
// module resolves without side effects in this test file.
vi.mock("@/sites/encompasshealth/flows/trigger-otp-flow", () => ({
  triggerOtpFlow: vi.fn().mockResolvedValue({ success: true }),
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

const preservedEnv = {
  DEV_BYPASS_AUTH: process.env.DEV_BYPASS_AUTH,
  NODE_ENV: process.env.NODE_ENV,
};

async function buildApp(): Promise<Parameters<typeof registerRoutes>[0]> {
  const app = Fastify({ loggerInstance: getLogger({ name: "resume-route-test" }) });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(errorHandlerPlugin);
  await app.register(authPlugin);
  await registerRoutes(app, cfgStub, [encompasshealthPlugin as SitePlugin<unknown, unknown>]);
  await app.ready();
  return app;
}

/**
 * Builds a multipart/form-data body for the /resume route. Includes the full
 * EncompasshealthPayload fields plus collectedData and otpCode.
 */
function buildResumeBody(opts: {
  boundary: string;
  collectedData?: Record<string, string>;
  otpCode?: string | null;
}): Buffer {
  const { boundary, collectedData = {}, otpCode = null } = opts;
  const answersJson = JSON.stringify(TEST_ANSWERS);
  const collectedDataJson = JSON.stringify(collectedData);

  const parts: Buffer[] = [
    Buffer.from(`--${boundary}\r\n`),
    Buffer.from(`Content-Disposition: form-data; name="JobId"\r\n\r\n`),
    Buffer.from(`JOB-001\r\n`),
    Buffer.from(`--${boundary}\r\n`),
    Buffer.from(`Content-Disposition: form-data; name="BaseUrl"\r\n\r\n`),
    Buffer.from(`https://careers.encompasshealth.com\r\n`),
    Buffer.from(`--${boundary}\r\n`),
    Buffer.from(`Content-Disposition: form-data; name="ClickUrl"\r\n\r\n`),
    Buffer.from(`https://careers.encompasshealth.com/j-ABC123\r\n`),
    Buffer.from(`--${boundary}\r\n`),
    Buffer.from(`Content-Disposition: form-data; name="FirstName"\r\n\r\n`),
    Buffer.from(`Jane\r\n`),
    Buffer.from(`--${boundary}\r\n`),
    Buffer.from(`Content-Disposition: form-data; name="LastName"\r\n\r\n`),
    Buffer.from(`Nurse\r\n`),
    Buffer.from(`--${boundary}\r\n`),
    Buffer.from(`Content-Disposition: form-data; name="Email"\r\n\r\n`),
    Buffer.from(`jane@example.com\r\n`),
    Buffer.from(`--${boundary}\r\n`),
    Buffer.from(`Content-Disposition: form-data; name="Phone"\r\n\r\n`),
    Buffer.from(`555-987-6543\r\n`),
    Buffer.from(`--${boundary}\r\n`),
    Buffer.from(`Content-Disposition: form-data; name="AddressLine"\r\n\r\n`),
    Buffer.from(`456 Oak Ave\r\n`),
    Buffer.from(`--${boundary}\r\n`),
    Buffer.from(`Content-Disposition: form-data; name="City"\r\n\r\n`),
    Buffer.from(`Birmingham\r\n`),
    Buffer.from(`--${boundary}\r\n`),
    Buffer.from(`Content-Disposition: form-data; name="State"\r\n\r\n`),
    Buffer.from(`AL\r\n`),
    Buffer.from(`--${boundary}\r\n`),
    Buffer.from(`Content-Disposition: form-data; name="PostalCode"\r\n\r\n`),
    Buffer.from(`35201\r\n`),
    Buffer.from(`--${boundary}\r\n`),
    Buffer.from(`Content-Disposition: form-data; name="Country"\r\n\r\n`),
    Buffer.from(`US\r\n`),
    Buffer.from(`--${boundary}\r\n`),
    Buffer.from(`Content-Disposition: form-data; name="County"\r\n\r\n`),
    Buffer.from(`Jefferson\r\n`),
    Buffer.from(`--${boundary}\r\n`),
    Buffer.from(`Content-Disposition: form-data; name="ResumeContentType"\r\n\r\n`),
    Buffer.from(`application/pdf\r\n`),
    Buffer.from(`--${boundary}\r\n`),
    Buffer.from(`Content-Disposition: form-data; name="ResumeFilename"\r\n\r\n`),
    Buffer.from(`resume.pdf\r\n`),
    Buffer.from(`--${boundary}\r\n`),
    Buffer.from(`Content-Disposition: form-data; name="ResumeBase64"\r\n\r\n`),
    Buffer.from(`\r\n`),
    Buffer.from(`--${boundary}\r\n`),
    Buffer.from(`Content-Disposition: form-data; name="Resume"; filename="resume.pdf"\r\n`),
    Buffer.from(`Content-Type: application/pdf\r\n\r\n`),
    Buffer.from(`PDF-BYTES`),
    Buffer.from(`\r\n--${boundary}\r\n`),
    Buffer.from(`Content-Disposition: form-data; name="Answers"\r\n\r\n`),
    Buffer.from(`${answersJson}\r\n`),
    Buffer.from(`--${boundary}\r\n`),
    Buffer.from(`Content-Disposition: form-data; name="collectedData"\r\n\r\n`),
    Buffer.from(`${collectedDataJson}\r\n`),
  ];

  if (otpCode !== null) {
    parts.push(
      Buffer.from(`--${boundary}\r\n`),
      Buffer.from(`Content-Disposition: form-data; name="otpCode"\r\n\r\n`),
      Buffer.from(`${otpCode}\r\n`)
    );
  }

  parts.push(Buffer.from(`--${boundary}--\r\n`));

  return Buffer.concat(parts);
}

describe("POST /v1/:siteId/resume — route integration", () => {
  beforeEach(() => {
    process.env.DEV_BYPASS_AUTH = "true";
    process.env.NODE_ENV = "test";
    mockResumeFlow.mockResolvedValue({ data: { verified: true } });
  });

  afterEach(async () => {
    if (preservedEnv.DEV_BYPASS_AUTH === undefined) delete process.env.DEV_BYPASS_AUTH;
    else process.env.DEV_BYPASS_AUTH = preservedEnv.DEV_BYPASS_AUTH;
    if (preservedEnv.NODE_ENV === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = preservedEnv.NODE_ENV;
    vi.clearAllMocks();
  });

  describe("success path", () => {
    it("returns 200 with status envelope and verified:true when resumeFlow resolves", async () => {
      const app = await buildApp();
      const boundary = "----barnacleResumeBoundary";
      const body = buildResumeBody({
        boundary,
        collectedData: { educationLevel: "Bachelor's" },
        otpCode: "123456",
      });

      const response = await app.inject({
        method: "POST",
        url: "/v1/encompasshealth/resume",
        headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
        payload: body,
      });

      expect(response.statusCode).toBe(200);
      const parsed = JSON.parse(response.body) as {
        status: { httpStatus: string; details: unknown[] };
        verified: boolean;
      };
      expect(parsed.status.httpStatus).toBe("OK");
      expect(parsed.status.details).toEqual([]);
      expect(typeof parsed.verified).toBe("boolean");
      expect(parsed.verified).toBe(true);

      await app.close();
    });

    it("returns verified:false when resumeFlow resolves with verified:false", async () => {
      mockResumeFlow.mockResolvedValue({ data: { verified: false } });
      const app = await buildApp();
      const boundary = "----barnacleResumeBoundary";
      const body = buildResumeBody({ boundary, otpCode: "999999" });

      const response = await app.inject({
        method: "POST",
        url: "/v1/encompasshealth/resume",
        headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
        payload: body,
      });

      expect(response.statusCode).toBe(200);
      const parsed = JSON.parse(response.body) as { verified: boolean };
      expect(parsed.verified).toBe(false);

      await app.close();
    });

    it("invokes resumeFlow with originalPayload, collectedData, and otpCode", async () => {
      const app = await buildApp();
      const boundary = "----barnacleResumeBoundary";
      const collectedData = { educationLevel: "Bachelor's Degree" };
      const body = buildResumeBody({ boundary, collectedData, otpCode: "654321" });

      await app.inject({
        method: "POST",
        url: "/v1/encompasshealth/resume",
        headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
        payload: body,
      });

      expect(mockResumeFlow).toHaveBeenCalledOnce();
      const call = mockResumeFlow.mock.calls[0]?.[0] as {
        originalPayload: { Email: string };
        collectedData: Record<string, string>;
        otpCode: string | null;
      };
      expect(call.originalPayload.Email).toBe("jane@example.com");
      expect(call.collectedData).toEqual(collectedData);
      expect(call.otpCode).toBe("654321");

      await app.close();
    });

    it("passes otpCode as null when the field is omitted from the body", async () => {
      const app = await buildApp();
      const boundary = "----barnacleResumeBoundary";
      const body = buildResumeBody({ boundary, otpCode: null });

      const response = await app.inject({
        method: "POST",
        url: "/v1/encompasshealth/resume",
        headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
        payload: body,
      });

      expect(response.statusCode).toBe(200);
      const call = mockResumeFlow.mock.calls[0]?.[0] as { otpCode: string | null };
      expect(call.otpCode).toBeNull();

      await app.close();
    });
  });

  describe("schema validation", () => {
    it("returns 400 with FIELD_VIOLATION (1002) when required fields are missing", async () => {
      const app = await buildApp();

      const response = await app.inject({
        method: "POST",
        url: "/v1/encompasshealth/resume",
        payload: {},
      });

      expect(response.statusCode).toBe(400);
      const parsed = JSON.parse(response.body) as {
        status: { details: Array<{ code: number }> };
      };
      expect(parsed.status.details[0]?.code).toBe(ERROR_CODES.FIELD_VIOLATION);
      expect(mockResumeFlow).not.toHaveBeenCalled();

      await app.close();
    });

    it("returns 400 with FIELD_VIOLATION (1002) for a non-multipart JSON body missing required fields", async () => {
      const app = await buildApp();

      const response = await app.inject({
        method: "POST",
        url: "/v1/encompasshealth/resume",
        payload: { Email: "not-an-email" },
      });

      expect(response.statusCode).toBe(400);
      const parsed = JSON.parse(response.body) as {
        status: { details: Array<{ code: number }> };
      };
      expect(parsed.status.details[0]?.code).toBe(ERROR_CODES.FIELD_VIOLATION);
      expect(mockResumeFlow).not.toHaveBeenCalled();

      await app.close();
    });
  });

  describe("OTP rejection", () => {
    it("returns 400 with RESUME_INVALID_OTP (2007) when resumeFlow signals rejected OTP", async () => {
      mockResumeFlow.mockRejectedValue(new InvalidOtpError("OTP rejected by Oracle HCM"));
      const app = await buildApp();
      const boundary = "----barnacleResumeBoundary";
      const body = buildResumeBody({ boundary, otpCode: "000000" });

      const response = await app.inject({
        method: "POST",
        url: "/v1/encompasshealth/resume",
        headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
        payload: body,
      });

      expect(response.statusCode).toBe(400);
      const parsed = JSON.parse(response.body) as {
        status: { httpStatus: string; details: Array<{ code: number; codeDescription: string }> };
      };
      expect(parsed.status.httpStatus).toBe("BAD_REQUEST");
      expect(parsed.status.details[0]?.code).toBe(ERROR_CODES.RESUME_INVALID_OTP);
      expect(parsed.status.details[0]?.codeDescription).toBe("RESUME_INVALID_OTP");

      await app.close();
    });
  });

  describe("authentication", () => {
    it("returns 401 when DEV_BYPASS_AUTH is false and no Authorization header is sent", async () => {
      process.env.DEV_BYPASS_AUTH = "false";
      const app = await buildApp();
      const boundary = "----barnacleResumeBoundary";
      const body = buildResumeBody({ boundary, otpCode: "123456" });

      const response = await app.inject({
        method: "POST",
        url: "/v1/encompasshealth/resume",
        headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
        payload: body,
      });

      expect(response.statusCode).toBe(401);
      expect(mockResumeFlow).not.toHaveBeenCalled();

      await app.close();
    });

    it("returns 200 when DEV_BYPASS_AUTH is true without an Authorization header", async () => {
      const app = await buildApp();
      const boundary = "----barnacleResumeBoundary";
      const body = buildResumeBody({ boundary, otpCode: "123456" });

      const response = await app.inject({
        method: "POST",
        url: "/v1/encompasshealth/resume",
        headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
        payload: body,
      });

      expect(response.statusCode).toBe(200);

      await app.close();
    });
  });
});
