import Fastify from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod/v4";

import authPlugin from "@/api/plugins/auth";
import errorHandlerPlugin from "@/api/plugins/error-handler";
import { loadConfig } from "@/config";
import { getLogger } from "@/lib/logging";
import { registerRoutes } from "@/plugins/loader";
import type { SitePlugin } from "@/site-plugin";

// Regression coverage for the multipart.maxFileSizeBytes wiring: builds the
// real (non-stubbed) AppConfig via loadConfig() so the 20 MiB default is
// exercised end-to-end against the actual @fastify/multipart registration,
// not a mock of the register call.
describe("registerRoutes — multipart file size limit (real config)", () => {
  const preservedEnv = {
    DEV_BYPASS_AUTH: process.env.DEV_BYPASS_AUTH,
    NODE_ENV: process.env.NODE_ENV,
    MULTIPART_MAX_FILE_SIZE_BYTES: process.env.MULTIPART_MAX_FILE_SIZE_BYTES,
  };

  beforeEach(() => {
    process.env.DEV_BYPASS_AUTH = "true";
    process.env.NODE_ENV = "test";
    delete process.env.MULTIPART_MAX_FILE_SIZE_BYTES;
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(preservedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    vi.clearAllMocks();
  });

  async function buildAppWithPlugin(
    plugin: SitePlugin<unknown, unknown>
  ): Promise<Parameters<typeof registerRoutes>[0]> {
    const app = Fastify({ loggerInstance: getLogger({ name: "loader-file-size-test" }) });
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    await app.register(errorHandlerPlugin);
    await app.register(authPlugin);
    await registerRoutes(app, loadConfig(), [plugin]);
    await app.ready();
    return app;
  }

  function buildMultipartBody(boundary: string, fileBytes: Buffer): Buffer {
    return Buffer.concat([
      Buffer.from(`--${boundary}\r\n`),
      Buffer.from(`Content-Disposition: form-data; name="Greeting"\r\n\r\n`),
      Buffer.from(`hello\r\n`),
      Buffer.from(`--${boundary}\r\n`),
      Buffer.from(
        `Content-Disposition: form-data; name="Resume"; filename="r.pdf"\r\n` +
          `Content-Type: application/pdf\r\n\r\n`
      ),
      fileBytes,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
  }

  function buildMultipartPlugin(executeHttp: SitePlugin<unknown, unknown>["executeHttp"]): SitePlugin<
    unknown,
    unknown
  > {
    return {
      meta: {
        siteId: "mp-size-test",
        displayName: "Multipart Size Test",
        bodySchema: z.object({
          Greeting: z.string(),
          Resume: z.instanceof(Buffer),
        }),
        responseSchema: z.unknown(),
        multipart: true,
      },
      execute: vi.fn(),
      executeHttp,
    };
  }

  it("accepts a >1 MiB résumé file part under the real 20 MiB default", async () => {
    const capturedPayload = vi.fn();
    const plugin = buildMultipartPlugin(async (payload) => {
      capturedPayload(payload);
      return { data: { ok: true } };
    });

    const app = await buildAppWithPlugin(plugin);
    const boundary = "----barnacleSizeTestBoundary";
    const fileBytes = Buffer.alloc(2 * 1024 * 1024, "a");
    const body = buildMultipartBody(boundary, fileBytes);

    const response = await app.inject({
      method: "POST",
      url: "/v1/mp-size-test/run",
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: body,
    });

    expect(response.statusCode).toBe(200);
    expect(capturedPayload).toHaveBeenCalledTimes(1);

    await app.close();
  });

  it("still rejects a file part over the configured 20 MiB cap with 413/code 1008", async () => {
    const capturedPayload = vi.fn();
    const plugin = buildMultipartPlugin(async (payload) => {
      capturedPayload(payload);
      return { data: { ok: true } };
    });

    const app = await buildAppWithPlugin(plugin);
    const boundary = "----barnacleSizeTestBoundaryOversize";
    const fileBytes = Buffer.alloc(25 * 1024 * 1024, "a");
    const body = buildMultipartBody(boundary, fileBytes);

    const response = await app.inject({
      method: "POST",
      url: "/v1/mp-size-test/run",
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: body,
    });

    expect(response.statusCode).toBe(413);
    expect(response.json().status.details[0].code).toBe(1008);
    expect(capturedPayload).not.toHaveBeenCalled();

    await app.close();
  });
});
