import Fastify, { type FastifyInstance } from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod/v4";

import errorHandlerPlugin from "@/api/plugins/error-handler";
import { clearResponseCache, getCachedResponse, getOrCreateInFlight } from "@/cache/response-cache";

/**
 * Builds an app whose routes stand in for the two failure modes that reach
 * `setErrorHandler` with a Zod-shaped error: a request-body violation and a
 * 200-response serialization failure. They must be treated differently —
 * only the latter may evict a cache entry — so this asserts the
 * discrimination rather than trusting it.
 */
async function buildApp(cacheKey: string): Promise<FastifyInstance> {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(errorHandlerPlugin);

  app.post("/body", { schema: { body: z.object({ n: z.number() }) } }, async (request) => {
    request.responseCacheKey = cacheKey;
    return { ok: true };
  });

  app.post(
    "/serializer",
    { schema: { response: { 200: z.object({ label: z.string() }) } } },
    async (request) => {
      request.responseCacheKey = cacheKey;
      return { label: null } as unknown as { label: string };
    }
  );

  await app.ready();
  return app;
}

describe("error handler response-cache eviction", () => {
  beforeEach(() => {
    clearResponseCache();
  });

  it("evicts the cached entry when the response fails its 200 schema", async () => {
    const { key } = getCachedResponse("/v1/site", { a: 1 });
    await getOrCreateInFlight(key, async () => ({ label: null }));
    expect(getCachedResponse("/v1/site", { a: 1 }).value).toBeDefined();

    const app = await buildApp(key);
    const res = await app.inject({ method: "POST", url: "/serializer", payload: {} });

    expect(res.statusCode).toBe(500);
    expect(getCachedResponse("/v1/site", { a: 1 }).value).toBeUndefined();
    await app.close();
  });

  it("does NOT evict on a request-body validation error", async () => {
    // A client sending a bad body must not be able to flush another caller's
    // cached result — the inverse bug of the one being fixed.
    const { key } = getCachedResponse("/v1/site", { a: 1 });
    await getOrCreateInFlight(key, async () => ({ good: true }));

    const app = await buildApp(key);
    const res = await app.inject({ method: "POST", url: "/body", payload: { n: "not-a-number" } });

    expect(res.statusCode).toBe(400);
    expect(getCachedResponse("/v1/site", { a: 1 }).value).toEqual({ good: true });
    await app.close();
  });

  it("leaves the cache alone when no key was recorded (a cache hit)", async () => {
    const { key } = getCachedResponse("/v1/site", { a: 1 });
    await getOrCreateInFlight(key, async () => ({ good: true }));

    const app = Fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    await app.register(errorHandlerPlugin);
    app.post(
      "/serializer",
      { schema: { response: { 200: z.object({ label: z.string() }) } } },
      async () => ({ label: null }) as unknown as { label: string }
    );
    await app.ready();

    const res = await app.inject({ method: "POST", url: "/serializer", payload: {} });
    expect(res.statusCode).toBe(500);
    expect(getCachedResponse("/v1/site", { a: 1 }).value).toEqual({ good: true });
    await app.close();
  });
});
