/**
 * Route-boundary regression guard: POST /v1/encompasshealth/run with an
 * incomplete Answers block must return HTTP 200 { needsUserInfo: true,
 * missingFields: [...], requiresOtp: false }, not 400 FIELD_VIOLATION.
 *
 * The strict ApplicationAnswersSchema used to reject incomplete Answers with
 * 400 at the route boundary, which meant detectMissingRequiredFields could
 * never run over HTTP — this test exists to prevent that regression.
 */

import Fastify from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import authPlugin from "@/api/plugins/auth";
import errorHandlerPlugin from "@/api/plugins/error-handler";
import type { AppConfig } from "@/config";
import { getLogger } from "@/lib/logging";
import { registerRoutes } from "@/plugins/loader";
import type { SitePlugin } from "@/site-plugin";
import { encompasshealthPlugin } from "@/sites/encompasshealth";
import { TEST_ANSWERS } from "@/testing/answers-fixture";
import { makeMockFetchResponse } from "@/testing/mock-fetch-response";
import { TEST_PERSONA } from "@/testing/persona-fixture";

const mockFetch = vi.fn();

vi.stubGlobal("fetch", mockFetch);

vi.mock("@/lib/telemetry/submission-capture", () => ({
  captureSubmissionEnvelope: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/cache/response-cache", () => ({
  getCachedResponse: vi.fn().mockReturnValue({ value: undefined, key: "test-key" }),
  getOrCreateInFlight: vi
    .fn()
    .mockImplementation((_key: string, producer: () => Promise<unknown>) => producer()),
}));

vi.mock("@/scraper/pool", () => ({
  runWithSession: vi.fn(),
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

vi.mock("@/sites/encompasshealth/flows/trigger-otp-flow", () => ({
  triggerOtpFlow: vi.fn().mockResolvedValue({ success: true }),
}));

vi.mock("@/sites/encompasshealth/flows/resume-flow", () => ({
  resumeFlow: vi.fn().mockResolvedValue({ data: { verified: true } }),
}));

const cfgStub = { scraper: { siteBaseUrls: {} } } as unknown as AppConfig;

const preservedEnv = {
  DEV_BYPASS_AUTH: process.env.DEV_BYPASS_AUTH,
  NODE_ENV: process.env.NODE_ENV,
};

function mockOracleHappyPath(): void {
  mockFetch.mockResolvedValueOnce(
    makeMockFetchResponse(201, JSON.stringify({ SourceTrackingId: 42 }))
  );
  mockFetch.mockResolvedValueOnce(
    makeMockFetchResponse(
      201,
      JSON.stringify({ AccessCode: "ACC-XYZ", AccessCodeExpirationDate: "2026-07-05T23:59:00Z" })
    )
  );
  mockFetch.mockResolvedValueOnce(
    makeMockFetchResponse(200, JSON.stringify({ items: [{ LegalDescriptionVersionId: 1001 }] }))
  );
  mockFetch.mockResolvedValueOnce(
    makeMockFetchResponse(200, JSON.stringify({ items: [{ QuestionnaireId: 2001 }] }))
  );
  mockFetch.mockResolvedValueOnce(makeMockFetchResponse(201, JSON.stringify({ APPDraftId: 3001 })));
  mockFetch.mockResolvedValueOnce(makeMockFetchResponse(201, JSON.stringify({})));
  mockFetch.mockResolvedValueOnce(makeMockFetchResponse(200, JSON.stringify({})));
  mockFetch.mockResolvedValueOnce(makeMockFetchResponse(201, JSON.stringify({})));
}

function buildRunBody(opts: { boundary: string; answers: Record<string, unknown> }): Buffer {
  const { boundary, answers } = opts;
  const answersJson = JSON.stringify(answers);

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
    Buffer.from(`${TEST_PERSONA.FirstName}\r\n`),
    Buffer.from(`--${boundary}\r\n`),
    Buffer.from(`Content-Disposition: form-data; name="LastName"\r\n\r\n`),
    Buffer.from(`${TEST_PERSONA.LastName}\r\n`),
    Buffer.from(`--${boundary}\r\n`),
    Buffer.from(`Content-Disposition: form-data; name="Email"\r\n\r\n`),
    Buffer.from(`test@example.com\r\n`),
    Buffer.from(`--${boundary}\r\n`),
    Buffer.from(`Content-Disposition: form-data; name="Phone"\r\n\r\n`),
    Buffer.from(`${TEST_PERSONA.Phone}\r\n`),
    Buffer.from(`--${boundary}\r\n`),
    Buffer.from(`Content-Disposition: form-data; name="AddressLine"\r\n\r\n`),
    Buffer.from(`${TEST_PERSONA.Address.Line1}\r\n`),
    Buffer.from(`--${boundary}\r\n`),
    Buffer.from(`Content-Disposition: form-data; name="City"\r\n\r\n`),
    Buffer.from(`${TEST_PERSONA.Address.City}\r\n`),
    Buffer.from(`--${boundary}\r\n`),
    Buffer.from(`Content-Disposition: form-data; name="State"\r\n\r\n`),
    Buffer.from(`${TEST_PERSONA.Address.StateName}\r\n`),
    Buffer.from(`--${boundary}\r\n`),
    Buffer.from(`Content-Disposition: form-data; name="PostalCode"\r\n\r\n`),
    Buffer.from(`${TEST_PERSONA.Address.PostalCode}\r\n`),
    Buffer.from(`--${boundary}\r\n`),
    Buffer.from(`Content-Disposition: form-data; name="Country"\r\n\r\n`),
    Buffer.from(`${TEST_PERSONA.Address.CountryCode}\r\n`),
    Buffer.from(`--${boundary}\r\n`),
    Buffer.from(`Content-Disposition: form-data; name="County"\r\n\r\n`),
    Buffer.from(`${TEST_PERSONA.Address.County}\r\n`),
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
    Buffer.from(`--${boundary}--\r\n`),
  ];

  return Buffer.concat(parts);
}

async function buildApp(): Promise<Parameters<typeof registerRoutes>[0]> {
  const app = Fastify({
    loggerInstance: getLogger({ name: "run-missing-fields-route-test" }),
  });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(errorHandlerPlugin);
  await app.register(authPlugin);
  await registerRoutes(app, cfgStub, [encompasshealthPlugin as SitePlugin<unknown, unknown>]);
  await app.ready();
  return app;
}

const COMPLETE_ANSWERS = {
  ...TEST_ANSWERS,
  Gender: "Male",
  Degree: "Bachelor",
  EducationLevel: "4",
  SignatureFullName: "Reginald Reconaldo",
  VisaSponsorship: "No",
  FormerEmployee: "No",
  CurrentNonEmployeeId: "N/A",
  OtherOpportunities: "No",
};

const INCOMPLETE_ANSWERS = ((): Record<string, unknown> => {
  const { EducationLevel: _omit, ...rest } = COMPLETE_ANSWERS;
  return rest;
})();

describe("POST /v1/encompasshealth/run — missing-fields route boundary", () => {
  beforeEach(() => {
    process.env.DEV_BYPASS_AUTH = "true";
    process.env.NODE_ENV = "test";
    mockFetch.mockReset();
  });

  afterEach(() => {
    if (preservedEnv.DEV_BYPASS_AUTH === undefined) delete process.env.DEV_BYPASS_AUTH;
    else process.env.DEV_BYPASS_AUTH = preservedEnv.DEV_BYPASS_AUTH;
    if (preservedEnv.NODE_ENV === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = preservedEnv.NODE_ENV;
    vi.clearAllMocks();
  });

  it("returns 200 (not 400) when EducationLevel is omitted", async () => {
    const app = await buildApp();
    const boundary = "----barnacleRunBoundary";
    const body = buildRunBody({ boundary, answers: INCOMPLETE_ANSWERS });

    const response = await app.inject({
      method: "POST",
      url: "/v1/encompasshealth/run",
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: body,
    });

    expect(response.statusCode).toBe(200);

    await app.close();
  });

  it("returns needsUserInfo === true when EducationLevel is omitted", async () => {
    const app = await buildApp();
    const boundary = "----barnacleRunBoundary";
    const body = buildRunBody({ boundary, answers: INCOMPLETE_ANSWERS });

    const response = await app.inject({
      method: "POST",
      url: "/v1/encompasshealth/run",
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: body,
    });

    const parsed = response.json<{ needsUserInfo: boolean }>();
    expect(parsed.needsUserInfo).toBe(true);

    await app.close();
  });

  it("returns requiresOtp === false for a missing-fields (non-OTP) response", async () => {
    const app = await buildApp();
    const boundary = "----barnacleRunBoundary";
    const body = buildRunBody({ boundary, answers: INCOMPLETE_ANSWERS });

    const response = await app.inject({
      method: "POST",
      url: "/v1/encompasshealth/run",
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: body,
    });

    const parsed = response.json<{ requiresOtp: boolean }>();
    expect(parsed.requiresOtp).toBe(false);

    await app.close();
  });

  it("returns missingFields containing EducationLevel", async () => {
    const app = await buildApp();
    const boundary = "----barnacleRunBoundary";
    const body = buildRunBody({ boundary, answers: INCOMPLETE_ANSWERS });

    const response = await app.inject({
      method: "POST",
      url: "/v1/encompasshealth/run",
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: body,
    });

    const parsed = response.json<{ missingFields: { field: string; question: string }[] }>();
    expect(Array.isArray(parsed.missingFields)).toBe(true);
    expect(parsed.missingFields.length).toBeGreaterThan(0);
    const fields = parsed.missingFields.map((f) => f.field);
    expect(fields).toContain("EducationLevel");

    await app.close();
  });

  it("returns 200 { verified: true } when all Answers fields are present (no 400 on complete payload)", async () => {
    mockOracleHappyPath();
    const app = await buildApp();
    const boundary = "----barnacleRunBoundary";
    const body = buildRunBody({ boundary, answers: COMPLETE_ANSWERS });

    const response = await app.inject({
      method: "POST",
      url: "/v1/encompasshealth/run",
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: body,
    });

    expect(response.statusCode).toBe(200);
    const parsed = response.json<{ verified: boolean }>();
    expect(parsed.verified).toBe(true);

    await app.close();
  });
});
