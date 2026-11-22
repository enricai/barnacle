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

describe("registerRoutes — extra route with dispatch: true", () => {
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
  });

  it("runs execute via dispatch and never calls the route handler", async () => {
    const handler = vi.fn();
    const execute = vi.fn();
    const executeHttp = vi.fn(async () => ({ data: { ok: 1 } }));
    const plugin: SitePlugin<unknown, unknown> = {
      meta: {
        siteId: "dispatch-site",
        displayName: "dispatch-site",
        bodySchema: z.object({}),
        responseSchema: z.unknown(),
        extraRoutes: [
          {
            method: "post",
            path: "/v1/dispatch-site/other",
            dispatch: true,
            handler,
          },
        ],
      },
      execute,
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
    const res = await app.inject({
      method: "POST",
      url: "/v1/dispatch-site/other",
      payload: {},
    });
    expect(handler).not.toHaveBeenCalled();
    expect(executeHttp).toHaveBeenCalled();
    expect(res.json()).toMatchObject({ ok: 1 });
    await app.close();
  });
});
