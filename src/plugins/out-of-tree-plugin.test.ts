import os from "node:os";
import path from "node:path";

import Fastify from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import authPlugin from "@/api/plugins/auth";
import errorHandlerPlugin from "@/api/plugins/error-handler";
import type { AppConfig } from "@/config";
import { getLogger } from "@/lib/logging";
import { loadPlugins } from "@/plugins/discover";
import { registerRoutes } from "@/plugins/loader";

// Stub runWithSession so the test does not require a live Steel session.
vi.mock("@/scraper/pool", () => ({
  runWithSession: vi.fn().mockImplementation((task: (s: null) => Promise<unknown>) => task(null)),
}));

// Stub the audit-persistence sink so the test does not write to disk.
vi.mock("@/lib/telemetry/submission-capture", () => ({
  captureSubmissionEnvelope: vi.fn().mockResolvedValue(undefined),
}));

const cfgStub = { scraper: { siteBaseUrls: {} } } as unknown as AppConfig;

/**
 * Proves the full loader→register→dispatch path using an out-of-tree plugin
 * loaded from a fixture in the OS temp dir, exercising the same code path an
 * operator's runtime plugin would take (no module-level static imports).
 */
describe("out-of-tree plugin — loader → registerRoutes → POST /run dispatch", () => {
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

  it("loads a plugin from a temp-dir path via loadPlugins and serves POST /v1/<siteId>/run returning 200 with a standard success envelope", async () => {
    // Use the e2e-plugin fixture which lives under __fixtures__ (not directly
    // in source), exercising the out-of-tree loading path via absolute path.
    const fixturePath = path.join(__dirname, "__fixtures__", "e2e-plugin.js");

    const { plugins, report } = await loadPlugins([fixturePath], {
      baseDir: os.tmpdir(),
      strict: false,
      seenSiteIds: new Set(),
    });

    expect(plugins).toHaveLength(1);
    expect(report[0]?.status).toBe("loaded");
    expect(report[0]?.siteId).toBe("e2e-plugin");

    const app = Fastify({ loggerInstance: getLogger({ name: "out-of-tree-plugin-test" }) });
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    await app.register(errorHandlerPlugin);
    await app.register(authPlugin);
    await registerRoutes(app, cfgStub, plugins);
    await app.ready();

    const response = await app.inject({
      method: "POST",
      url: "/v1/e2e-plugin/run",
      payload: { query: "hello" },
    });

    expect(response.statusCode).toBe(200);

    const body = JSON.parse(response.body) as {
      status: { httpStatus: string };
      result: string;
    };
    expect(body.status.httpStatus).toBe("OK");
    expect(body.result).toBe("e2e-ok");

    await app.close();
  });
});
