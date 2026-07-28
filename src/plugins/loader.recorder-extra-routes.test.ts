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

// vi.hoisted runs before vi.mock factories — required so this reference is
// available when the factory closure below executes.
const mockCaptureBeaconEvent = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

// Re-implemented rather than vi.importActual'd because the production
// createBeaconOutcomeRecorder closure over captureBeaconEvent is a
// same-module reference, not an import — importing the actual module would
// bypass mockCaptureBeaconEvent and hit the real NDJSON sink.
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

describe("registerRoutes — recordBeaconOutcome binding in the extraRoutes context", () => {
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

  async function buildAppWithPlugin(
    plugin: SitePlugin<unknown, unknown>
  ): Promise<Parameters<typeof registerRoutes>[0]> {
    const app = Fastify({
      loggerInstance: getLogger({ name: "loader-recorder-extra-routes-test" }),
      genReqId: () => "req-extra-fixed",
    });
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    await app.register(errorHandlerPlugin);
    await app.register(authPlugin);
    await registerRoutes(app, cfgStub, [plugin]);
    await app.ready();
    return app;
  }

  const makePlugin = (
    siteId: string,
    handler: SitePluginExtraRoute["handler"]
  ): SitePlugin<unknown, unknown> => ({
    meta: {
      siteId,
      displayName: siteId,
      bodySchema: z.object({}),
      responseSchema: z.unknown(),
      extraRoutes: [
        {
          method: "post",
          path: `/v1/${siteId}/action`,
          handler,
        },
      ],
    },
    execute: vi.fn(),
  });

  it("reaches captureBeaconEvent exactly once with this request's requestId, the plugin's siteId, and the verbatim joinKeys — no automatic 'skipped' line, since extra routes bypass dispatch()", async () => {
    const joinKeys = { vivclid: "789", jid: "job-42" };
    const extraHandler = vi.fn().mockImplementation(async (_request, context) => {
      await context.recordBeaconOutcome({ beaconStatus: "fired", joinKeys });
      return { done: true };
    });
    const plugin = makePlugin("recorder-extra-fired", extraHandler);
    const app = await buildAppWithPlugin(plugin);

    const response = await app.inject({
      method: "POST",
      url: "/v1/recorder-extra-fired/action",
      payload: {},
    });

    expect(response.statusCode).toBe(200);
    expect(mockCaptureBeaconEvent).toHaveBeenCalledTimes(1);
    expect(mockCaptureBeaconEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: "req-extra-fixed",
        siteId: "recorder-extra-fired",
        joinKeys,
        beaconStatus: "fired",
      })
    );
    // Only the plugin's own "fired" line exists — dispatch() is never
    // invoked for an extra route, so no automatic "skipped" line is written.
    const beaconStatuses = mockCaptureBeaconEvent.mock.calls.map(
      ([call]) => (call as { beaconStatus: string }).beaconStatus
    );
    expect(beaconStatuses).toEqual(["fired"]);

    await app.close();
  });

  it("returns the handler's enveloped 200 response even when the recorder's underlying capture rejects", async () => {
    mockCaptureBeaconEvent.mockRejectedValueOnce(new Error("sink unavailable"));
    const extraHandler = vi.fn().mockImplementation(async (_request, context) => {
      await context.recordBeaconOutcome({ beaconStatus: "failed", joinKeys: { vivclid: "789" } });
      return { done: true };
    });
    const plugin = makePlugin("recorder-extra-reject", extraHandler);
    const app = await buildAppWithPlugin(plugin);

    const response = await app.inject({
      method: "POST",
      url: "/v1/recorder-extra-reject/action",
      payload: {},
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as {
      status: { httpStatus: string };
      done: boolean;
    };
    expect(body.status.httpStatus).toBe("OK");
    expect(body.done).toBe(true);
    expect(mockCaptureBeaconEvent).toHaveBeenCalledTimes(1);

    await app.close();
  });
});
