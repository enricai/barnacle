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

const mockRunWithSession = vi.hoisted(() =>
  vi.fn(async (task: (s: unknown) => unknown) => task(null))
);
vi.mock("@/scraper/pool", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/scraper/pool")>()),
  runWithSession: mockRunWithSession,
}));

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

  async function appWith() {
    const executeHttp = vi.fn(async (_body: unknown) => ({ data: { ok: true } }));
    const plugin = {
      meta: {
        siteId: "idem-site",
        displayName: "idem-site",
        bodySchema: z.looseObject({}),
        responseSchema: z.unknown(),
        idempotency: { keyFields: ["orderRef"] },
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
    const { app, executeHttp } = await appWith();
    const payload = { orderRef: `ref-${Date.now()}-${Math.random()}` };
    const first = await app.inject({ method: "POST", url: "/v1/idem-site/run", payload });
    const second = await app.inject({ method: "POST", url: "/v1/idem-site/run", payload });
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(executeHttp).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it("accepts async submissions with 202 and exposes the operation via polling", async () => {
    const { app, executeHttp } = await appWith();
    const payload = { orderRef: `async-${Date.now()}-${Math.random()}` };
    const res = await app.inject({
      method: "POST",
      url: "/v1/idem-site/run",
      payload,
      headers: { "x-barnacle-async": "true" },
    });
    expect(res.statusCode).toBe(202);
    const data = res.json();
    expect(data.operationStatus).toBe("pending");
    expect(data.pollUrl).toBe(`/v1/idem-site/run/operations/${data.operationId}`);
    let body: { operationStatus: string; result?: unknown } | undefined;
    for (let i = 0; i < 50; i++) {
      const poll = await app.inject({ method: "GET", url: data.pollUrl });
      expect(poll.statusCode).toBe(200);
      body = poll.json();
      if (body?.operationStatus !== "pending") break;
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(body?.operationStatus).toBe("succeeded");
    expect(body?.result).toMatchObject({ ok: true });
    expect(executeHttp).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it("falls back to sync when async has no key, and rejects unknown operations", async () => {
    const { app } = await appWith();
    const res = await app.inject({
      method: "POST",
      url: "/v1/idem-site/run",
      payload: {},
      headers: { "x-barnacle-async": "true" },
    });
    expect(res.statusCode).toBe(200);
    const poll = await app.inject({ method: "GET", url: "/v1/idem-site/run/operations/nope" });
    expect(poll.statusCode).toBeGreaterThanOrEqual(400);
    await app.close();
  });

  it("dedupes a dispatch-opted extra route and defaults maxAttempts to 1 on the browser path", async () => {
    const execute = vi.fn(async () => ({ data: { ok: true } }));
    const handler = vi.fn(async () => ({ from: "handler" }));
    const plugin = {
      meta: {
        siteId: "idem-extra-site",
        displayName: "idem-extra-site",
        bodySchema: z.looseObject({}),
        responseSchema: z.unknown(),
        idempotency: { keyFields: ["orderRef"] },
        extraRoutes: [
          {
            method: "post",
            path: "/v1/idem-extra-site/apply",
            handler,
            dispatch: true,
            envelope: false,
          },
        ],
      },
      execute,
    } as unknown as SitePlugin<unknown, unknown>;
    const app = Fastify({ loggerInstance: getLogger({ name: "loader-idempotency-extra" }) });
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    await app.register(errorHandlerPlugin);
    await app.register(authPlugin);
    await registerRoutes(app, cfgStub, [plugin]);
    await app.ready();
    const payload = { orderRef: `extra-${Date.now()}-${Math.random()}` };
    const url = "/v1/idem-extra-site/apply";
    const a = await app.inject({ method: "POST", url, payload });
    const b = await app.inject({ method: "POST", url, payload });
    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);
    expect(handler).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledTimes(1);
    expect(mockRunWithSession).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({ maxAttempts: 1 }),
      undefined,
      expect.anything()
    );
    await app.close();
  });
});
