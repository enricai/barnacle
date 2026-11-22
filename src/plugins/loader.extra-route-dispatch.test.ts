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
vi.mock("@/lib/telemetry/submission-capture", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/telemetry/submission-capture")>()),
  captureSubmissionEnvelope: mockCaptureSubmissionEnvelope,
}));

const mockCaptureBeaconEvent = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("@/lib/telemetry/beacon-capture", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/telemetry/beacon-capture")>()),
  captureBeaconEvent: mockCaptureBeaconEvent,
}));

describe("registerRoutes — opt-in dispatch on extra routes", () => {
  const cfgStub = { scraper: { siteBaseUrls: {} } } as unknown as AppConfig;
  const saved = { b: process.env.DEV_BYPASS_AUTH, n: process.env.NODE_ENV };

  beforeEach(() => {
    process.env.DEV_BYPASS_AUTH = "true";
    process.env.NODE_ENV = "test";
  });
  afterEach(() => {
    if (saved.b === undefined) delete process.env.DEV_BYPASS_AUTH;
    else process.env.DEV_BYPASS_AUTH = saved.b;
    if (saved.n === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = saved.n;
    vi.clearAllMocks();
  });

  async function appWith(dispatch: boolean | undefined) {
    const handler = vi.fn(async () => ({ from: "handler" }));
    const executeHttp = vi.fn(async (_body: unknown) => ({ data: { from: "executeHttp" } }));
    const plugin: SitePlugin<unknown, unknown> = {
      meta: {
        siteId: "example-site",
        displayName: "example-site",
        bodySchema: z.looseObject({}),
        responseSchema: z.unknown(),
        extraRoutes: [
          { method: "post", path: "/v1/example-site/apply", handler, dispatch, envelope: false },
        ],
      },
      execute: vi.fn(),
      executeHttp,
    } as unknown as SitePlugin<unknown, unknown>;
    const app = Fastify({
      loggerInstance: getLogger({ name: "loader-extra-route-dispatch-test" }),
    });
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    await app.register(errorHandlerPlugin);
    await app.register(authPlugin);
    await registerRoutes(app, cfgStub, [plugin]);
    await app.ready();
    return { app, handler, executeHttp };
  }

  const payload = { Email: "user@example.com", reply1: "yes", reply2: "no" };

  it("with dispatch: true runs executeHttp with the replies and never the handler", async () => {
    const { app, handler, executeHttp } = await appWith(true);

    const res = await app.inject({ method: "POST", url: "/v1/example-site/apply", payload });

    expect(res.statusCode).toBe(200);
    expect(handler).not.toHaveBeenCalled();
    expect(executeHttp).toHaveBeenCalledTimes(1);
    expect(executeHttp.mock.calls[0]?.[0]).toMatchObject(payload);
    const json = res.json();
    expect(json.from).toBe("executeHttp");
    expect(json.status).toEqual(
      expect.objectContaining({ httpStatus: expect.any(String), details: expect.any(Array) })
    );
    await app.close();
  });

  it("without the flag runs the handler and not the dispatch pipeline", async () => {
    const { app, handler, executeHttp } = await appWith(undefined);

    const res = await app.inject({ method: "POST", url: "/v1/example-site/apply", payload });

    expect(res.statusCode).toBe(200);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(executeHttp).not.toHaveBeenCalled();
    await app.close();
  });
});
