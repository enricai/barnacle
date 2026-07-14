/**
 * Route-boundary test: POST /v1/{siteId}/run with a needsUserInfo hot-path
 * result must return HTTP 200 with body {needsUserInfo:true, missingFields, requiresOtp}.
 * Dispatch-unit assertions live in loader.test.ts; this file covers only the
 * HTTP status + body shape at the app.inject() boundary.
 */
import Fastify from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod/v4";

import authPlugin from "@/api/plugins/auth";
import errorHandlerPlugin from "@/api/plugins/error-handler";
import type { AppConfig } from "@/config";
import { getLogger } from "@/lib/logging";
import { registerRoutes } from "@/plugins/loader";
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
const mockFireTrackingClick = vi.hoisted(() => vi.fn());
const mockTriggerOtpFlow = vi.hoisted(() => vi.fn().mockResolvedValue({ success: true }));
const mockResumeFlow = vi.hoisted(() => vi.fn().mockResolvedValue({ data: { verified: true } }));

vi.mock("@/lib/telemetry/submission-capture", () => ({
  captureSubmissionEnvelope: mockCaptureSubmissionEnvelope,
}));

vi.mock("@/cache/response-cache", () => ({
  getCachedResponse: mockGetCachedResponse,
  getOrCreateInFlight: mockGetOrCreateInFlight,
}));

vi.mock("@/scraper/pool", () => ({
  runWithSession: mockRunWithSession,
}));

vi.mock("@/lib/tracking-click", () => ({
  fireTrackingClick: mockFireTrackingClick,
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
  triggerOtpFlow: mockTriggerOtpFlow,
}));

vi.mock("@/sites/encompasshealth/flows/resume-flow", () => ({
  resumeFlow: mockResumeFlow,
}));

describe("POST /v1/{siteId}/run — needsUserInfo HTTP boundary", () => {
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
    const app = Fastify({ loggerInstance: getLogger({ name: "needs-user-info-route-test" }) });
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    await app.register(errorHandlerPlugin);
    await app.register(authPlugin);
    await registerRoutes(app, cfgStub, [plugin]);
    await app.ready();
    return app;
  }

  it("returns statusCode 200 when executeHttp resolves needsUserInfo=true", async () => {
    const needsUserInfoPlugin: SitePlugin<unknown, unknown> = {
      meta: {
        siteId: "nui-test",
        displayName: "NUI Test",
        bodySchema: z.object({}),
        responseSchema: z.unknown(),
      },
      execute: vi.fn(),
      executeHttp: async () => ({
        data: {
          verified: false as const,
          needsUserInfo: true as const,
          missingFields: [] as { field: string; question: string }[],
          requiresOtp: true,
        },
      }),
    };

    const app = await buildAppWithPlugin(needsUserInfoPlugin);

    const response = await app.inject({
      method: "POST",
      url: "/v1/nui-test/run",
      payload: {},
    });

    expect(response.statusCode).toBe(200);

    await app.close();
  });

  it("returns body.needsUserInfo === true", async () => {
    const nuiPlugin: SitePlugin<unknown, unknown> = {
      meta: {
        siteId: "nui-test2",
        displayName: "NUI Test 2",
        bodySchema: z.object({}),
        responseSchema: z.unknown(),
      },
      execute: vi.fn(),
      executeHttp: async () => ({
        data: {
          verified: false as const,
          needsUserInfo: true as const,
          missingFields: [] as { field: string; question: string }[],
          requiresOtp: false,
        },
      }),
    };

    const app = await buildAppWithPlugin(nuiPlugin);

    const response = await app.inject({
      method: "POST",
      url: "/v1/nui-test2/run",
      payload: {},
    });

    const body = response.json<{ needsUserInfo: boolean }>();
    expect(body.needsUserInfo).toBe(true);

    await app.close();
  });

  it("returns body.missingFields as an array", async () => {
    const missingFields = [
      { field: "educationLevel", question: "What is your highest level of education?" },
      { field: "veteranStatus", question: "Are you a veteran?" },
    ];

    const nuiPlugin: SitePlugin<unknown, unknown> = {
      meta: {
        siteId: "nui-test3",
        displayName: "NUI Test 3",
        bodySchema: z.object({}),
        responseSchema: z.unknown(),
      },
      execute: vi.fn(),
      executeHttp: async () => ({
        data: {
          verified: false as const,
          needsUserInfo: true as const,
          missingFields,
          requiresOtp: false,
        },
      }),
    };

    const app = await buildAppWithPlugin(nuiPlugin);

    const response = await app.inject({
      method: "POST",
      url: "/v1/nui-test3/run",
      payload: {},
    });

    const body = response.json<{
      missingFields: { field: string; question: string }[];
    }>();
    expect(Array.isArray(body.missingFields)).toBe(true);
    expect(body.missingFields).toHaveLength(2);
    expect(body.missingFields[0]?.field).toBe("educationLevel");

    await app.close();
  });

  it("returns body.requiresOtp as a boolean", async () => {
    const nuiPlugin: SitePlugin<unknown, unknown> = {
      meta: {
        siteId: "nui-test4",
        displayName: "NUI Test 4",
        bodySchema: z.object({}),
        responseSchema: z.unknown(),
      },
      execute: vi.fn(),
      executeHttp: async () => ({
        data: {
          verified: false as const,
          needsUserInfo: true as const,
          missingFields: [] as { field: string; question: string }[],
          requiresOtp: true,
        },
      }),
    };

    const app = await buildAppWithPlugin(nuiPlugin);

    const response = await app.inject({
      method: "POST",
      url: "/v1/nui-test4/run",
      payload: {},
    });

    const body = response.json<{ requiresOtp: boolean }>();
    expect(typeof body.requiresOtp).toBe("boolean");
    expect(body.requiresOtp).toBe(true);

    await app.close();
  });

  it("returns body.requiresOtp=false when OTP is not needed", async () => {
    const nuiPlugin: SitePlugin<unknown, unknown> = {
      meta: {
        siteId: "nui-test5",
        displayName: "NUI Test 5",
        bodySchema: z.object({}),
        responseSchema: z.unknown(),
      },
      execute: vi.fn(),
      executeHttp: async () => ({
        data: {
          verified: false as const,
          needsUserInfo: true as const,
          missingFields: [
            { field: "educationLevel", question: "What is your highest level of education?" },
          ],
          requiresOtp: false,
        },
      }),
    };

    const app = await buildAppWithPlugin(nuiPlugin);

    const response = await app.inject({
      method: "POST",
      url: "/v1/nui-test5/run",
      payload: {},
    });

    const body = response.json<{ requiresOtp: boolean }>();
    expect(body.requiresOtp).toBe(false);

    await app.close();
  });
});
