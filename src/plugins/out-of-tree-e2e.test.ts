import path from "node:path";

import Fastify from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import authPlugin from "@/api/plugins/auth";
import errorHandlerPlugin from "@/api/plugins/error-handler";
import type { AppConfig } from "@/config";
import { getLogger } from "@/lib/logging";
import { loadPlugins, type PluginLoadRecord } from "@/plugins/discover";
import { registerRoutes } from "@/plugins/loader";

// Stub runWithSession so the e2e test does not require a live Steel session.
vi.mock("@/scraper/pool", () => ({
  runWithSession: vi.fn().mockImplementation((task: (s: null) => Promise<unknown>) => task(null)),
}));

// Stub the audit-persistence sink so the test does not write to disk.
vi.mock("@/lib/telemetry/submission-capture", () => ({
  captureSubmissionEnvelope: vi.fn().mockResolvedValue(undefined),
}));

const FIXTURE_PATH = path.join(__dirname, "__fixtures__", "e2e-plugin.js");

const cfgStub = { scraper: { siteBaseUrls: {} } } as unknown as AppConfig;

describe("out-of-tree plugin — end-to-end: loadPlugins → registerRoutes → /run", () => {
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

  it("loadPlugins returns one loaded plugin and a loaded report record for the e2e fixture", async () => {
    const { plugins, report } = await loadPlugins([FIXTURE_PATH], {
      baseDir: process.cwd(),
      strict: false,
      seenSiteIds: new Set(),
    });

    expect(plugins).toHaveLength(1);
    expect(report).toHaveLength(1);

    const rec = report[0] as PluginLoadRecord;
    expect(rec.status).toBe("loaded");
    expect(rec.siteId).toBe("e2e-plugin");
    expect(rec.displayName).toBe("E2E Out-of-Tree Plugin");
    expect(rec.route).toBe("/v1/e2e-plugin/run");
  });

  it("POST /v1/e2e-plugin/run returns 200 with a standard success envelope carrying the plugin's canned data", async () => {
    const { plugins } = await loadPlugins([FIXTURE_PATH], {
      baseDir: process.cwd(),
      strict: false,
      seenSiteIds: new Set(),
    });

    const app = Fastify({ loggerInstance: getLogger({ name: "e2e-test" }) });
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    await app.register(errorHandlerPlugin);
    await app.register(authPlugin);
    await registerRoutes(app, cfgStub, plugins);
    await app.ready();

    const response = await app.inject({
      method: "POST",
      url: "/v1/e2e-plugin/run",
      payload: { query: "test" },
    });

    expect(response.statusCode).toBe(200);

    const body = JSON.parse(response.body) as {
      status: { httpStatus: string; dateTime: string; details: unknown[] };
      result: string;
    };
    expect(body.status.httpStatus).toBe("OK");
    expect(body.status.details).toEqual([]);
    expect(body.result).toBe("e2e-ok");

    await app.close();
  });
});
