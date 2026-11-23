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

vi.mock("@/lib/telemetry/submission-capture", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/telemetry/submission-capture")>()),
  captureSubmissionEnvelope: vi.fn().mockResolvedValue(undefined),
}));

describe("registerRoutes — meta.idempotency guard around dispatch", () => {
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

  async function appWith(idempotency: boolean) {
    const executeHttp = vi.fn(async (_body: unknown) => ({ data: { ok: true } }));
    const plugin = {
      meta: {
        siteId: "idem-site",
        displayName: "idem-site",
        bodySchema: z.looseObject({}),
        responseSchema: z.unknown(),
        ...(idempotency && { idempotency: { keyFields: ["orderRef"] } }),
      },
      execute: vi.fn(),
      executeHttp,
    } as unknown as SitePlugin<unknown, unknown>;
    const app = Fastify({ loggerInstance: getLogger({ name: "loader-idempotency-test" }) });
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    await app.register(errorHandlerPlugin);
    await app.register(authPlugin);
    await registerRoutes(app, cfgStub, [plugin]);
    await app.ready();
    return { app, executeHttp };
  }

  it("runs a duplicate submission once when the plugin declares idempotency", async () => {
    const { app, executeHttp } = await appWith(true);
    const payload = { orderRef: `ref-${Date.now()}-${Math.random()}` };
    const first = await app.inject({ method: "POST", url: "/v1/idem-site/run", payload });
    const second = await app.inject({ method: "POST", url: "/v1/idem-site/run", payload });
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(executeHttp).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it("dispatches every request when no idempotency is declared", async () => {
    const { app, executeHttp } = await appWith(false);
    const payload = { orderRef: "same" };
    await app.inject({ method: "POST", url: "/v1/idem-site/run", payload });
    await app.inject({ method: "POST", url: "/v1/idem-site/run", payload });
    expect(executeHttp).toHaveBeenCalledTimes(2);
    await app.close();
  });
});
