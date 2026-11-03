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

describe("registerRoutes — extra route handlers receive query, headers and reply", () => {
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

  async function appWith(handler: SitePluginExtraRoute["handler"]) {
    const plugin: SitePlugin<unknown, unknown> = {
      meta: {
        siteId: "reply-site",
        displayName: "reply-site",
        bodySchema: z.object({}),
        responseSchema: z.unknown(),
        extraRoutes: [{ method: "post", path: "/v1/reply-site/books", handler, envelope: false }],
      },
      execute: vi.fn(),
    };
    const app = Fastify({ loggerInstance: getLogger({ name: "loader-extra-route-reply-test" }) });
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    await app.register(errorHandlerPlugin);
    await app.register(authPlugin);
    await registerRoutes(app, cfgStub, [plugin]);
    await app.ready();
    return app;
  }

  it("passes query/headers and lets the handler set 201, a header and a custom body", async () => {
    const app = await appWith(async ({ query, headers, reply }) => {
      reply.code(201).header("location", "/books/1");
      return reply.send({ tags: query.tag, key: headers["x-api-key"] });
    });
    const res = await app.inject({
      method: "POST",
      url: "/v1/reply-site/books?tag=a&tag=b",
      headers: { "x-api-key": "k1" },
      payload: {},
    });
    expect(res.statusCode).toBe(201);
    expect(res.headers.location).toBe("/books/1");
    expect(res.json()).toEqual({ tags: ["a", "b"], key: "k1" });
    await app.close();
  });
});
