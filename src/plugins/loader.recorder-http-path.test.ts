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
const mockCaptureBeaconEvent = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockGetCachedResponse = vi.hoisted(() =>
  vi.fn().mockReturnValue({ value: undefined, key: "test-key" })
);
const mockGetOrCreateInFlight = vi.hoisted(() =>
  vi.fn().mockImplementation((_key: string, producer: () => Promise<unknown>) => producer())
);
const mockRunWithSession = vi.hoisted(() =>
  vi.fn().mockImplementation((task: (s: null) => Promise<unknown>) => task(null))
);

// Stub runWithSession so the HttpSchemaError fallback branch doesn't need a
// real Steel session or pool setup.
vi.mock("@/scraper/pool", () => ({
  runWithSession: mockRunWithSession,
}));

vi.mock("@/lib/telemetry/submission-capture", () => ({
  captureSubmissionEnvelope: mockCaptureSubmissionEnvelope,
}));

// Force every call a cache miss so both branches under test (executeHttp
// resolving, and executeHttp rejecting into the browser fallback) actually
// invoke the plugin instead of short-circuiting on a cached response.
vi.mock("@/cache/response-cache", () => ({
  getCachedResponse: mockGetCachedResponse,
  getOrCreateInFlight: mockGetOrCreateInFlight,
}));

// createBeaconOutcomeRecorder's mock double replicates the real factory's
// binding + never-throw wrapping around captureBeaconEvent, copied verbatim
// from loader.test.ts. It is re-implemented here rather than
// vi.importActual'd because the production closure over captureBeaconEvent is
// a same-module reference, not an import — the actual module would bypass
// mockCaptureBeaconEvent entirely and hit the real sink.
vi.mock("@/lib/telemetry/beacon-capture", () => ({
  captureBeaconEvent: mockCaptureBeaconEvent,
  createBeaconOutcomeRecorder: vi.fn(
    (binding: { requestId: string; siteId: string }) =>
      async (input: {
        beaconStatus: string;
        joinKeys: unknown;
        trackingUrl?: string | null;
        durationMs?: number;
      }) => {
        try {
          await mockCaptureBeaconEvent({
            requestId: binding.requestId,
            siteId: binding.siteId,
            joinKeys: input.joinKeys,
            beaconStatus: input.beaconStatus,
            trackingUrl: input.trackingUrl ?? null,
            durationMs: input.durationMs ?? 0,
          });
        } catch {
          // swallow, matching the real factory's never-throw contract
        }
      }
  ),
}));

describe("dispatch — recordBeaconOutcome binding through executeHttp and its browser fallback", () => {
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
      loggerInstance: getLogger({ name: "loader-recorder-http-path-test" }),
      genReqId: () => "req-http-path-fixed",
    });
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    await app.register(errorHandlerPlugin);
    await app.register(authPlugin);
    await registerRoutes(app, cfgStub, [plugin]);
    await app.ready();
    return app;
  }

  it("reaches captureBeaconEvent with the run's requestId, the plugin's siteId, and the verbatim joinKeys when executeHttp calls context.recordBeaconOutcome", async () => {
    const plugin: SitePlugin<unknown, unknown> = {
      meta: {
        siteId: "recorder-http-hot-test",
        displayName: "Recorder HTTP Hot Test",
        bodySchema: z.object({}),
        responseSchema: z.unknown(),
      },
      executeHttp: async (_payload, context) => {
        await context.recordBeaconOutcome({
          beaconStatus: "fired",
          joinKeys: { vivclid: "abc", jobReference: "emp1_job1" },
        });
        return { data: { ok: true, path: "http" } };
      },
      execute: vi.fn(),
    };
    const app = await buildAppWithPlugin(plugin);

    const response = await app.inject({
      method: "POST",
      url: "/v1/recorder-http-hot-test/run",
      payload: {},
    });

    expect(response.statusCode).toBe(200);
    expect(mockCaptureBeaconEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: "req-http-path-fixed",
        siteId: "recorder-http-hot-test",
        joinKeys: { vivclid: "abc", jobReference: "emp1_job1" },
        beaconStatus: "fired",
      })
    );

    await app.close();
  });

  it("carries the same requestId on the executeHttp-recorded outcome and a later execute-recorded outcome after an HttpSchemaError fallback", async () => {
    const plugin: SitePlugin<unknown, unknown> = {
      meta: {
        siteId: "recorder-http-fallback-test",
        displayName: "Recorder HTTP Fallback Test",
        bodySchema: z.object({}),
        responseSchema: z.unknown(),
      },
      executeHttp: async (_payload, context) => {
        await context.recordBeaconOutcome({
          beaconStatus: "failed",
          joinKeys: { attempt: "http" },
        });
        throw new HttpSchemaError("schema mismatch");
      },
      execute: async (_payload, _session, context) => {
        await context.recordBeaconOutcome({
          beaconStatus: "fired",
          joinKeys: { attempt: "browser" },
        });
        return { data: { ok: true, path: "browser" } };
      },
    };
    const app = await buildAppWithPlugin(plugin);

    const response = await app.inject({
      method: "POST",
      url: "/v1/recorder-http-fallback-test/run",
      payload: {},
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as { path: string };
    expect(body.path).toBe("browser");

    const recordedCalls = mockCaptureBeaconEvent.mock.calls
      .map(([call]) => call as { requestId: string; joinKeys: { attempt: string } | null })
      .filter((call) => ["http", "browser"].includes(call.joinKeys?.attempt ?? ""));

    expect(recordedCalls).toHaveLength(2);
    // biome-ignore lint/style/noNonNullAssertion: length asserted to be 2 above, so indexes 0 and 1 are present
    const httpCall = recordedCalls[0]!;
    // biome-ignore lint/style/noNonNullAssertion: length asserted to be 2 above, so indexes 0 and 1 are present
    const browserCall = recordedCalls[1]!;
    expect(httpCall.joinKeys?.attempt).toBe("http");
    expect(browserCall.joinKeys?.attempt).toBe("browser");
    expect(httpCall.requestId).toBe("req-http-path-fixed");
    expect(browserCall.requestId).toBe("req-http-path-fixed");
    expect(httpCall.requestId).toBe(browserCall.requestId);

    await app.close();
  });

  it("does not fail the route when the recorder's underlying capture rejects on the executeHttp hot path — the route still returns 200 with the plugin's data", async () => {
    mockCaptureBeaconEvent.mockRejectedValueOnce(new Error("sink unavailable"));
    const plugin: SitePlugin<unknown, unknown> = {
      meta: {
        siteId: "recorder-http-reject-test",
        displayName: "Recorder HTTP Reject Test",
        bodySchema: z.object({}),
        responseSchema: z.unknown(),
      },
      executeHttp: async (_payload, context) => {
        await context.recordBeaconOutcome({ beaconStatus: "fired", joinKeys: { k: 1 } });
        return { data: { ok: true, path: "http" } };
      },
      execute: vi.fn(),
    };
    const app = await buildAppWithPlugin(plugin);

    const response = await app.inject({
      method: "POST",
      url: "/v1/recorder-http-reject-test/run",
      payload: {},
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as { ok: boolean; path: string };
    expect(body.ok).toBe(true);
    expect(body.path).toBe("http");

    await app.close();
  });
});
