/**
 * Boot/route regression guard for the pino-pretty prod-crash incident
 * (2026-07-14): a module-level `getScriptLogger()` call in a server-runtime
 * module (`judge.ts`, reached via `flow-runner.ts`) built a pino-pretty
 * transport unconditionally. `pino-pretty` is a devDependency pruned from
 * the prod image, so importing that module under a non-dev NODE_ENV threw
 * at import time and crashed the server before any route registered —
 * `POST /v1/hca/run` returned 404 RESOURCE_NOT_FOUND (route absent) instead
 * of 400 FIELD_VIOLATION (route present, payload rejected).
 *
 * Dynamically re-imports `hcaPlugin` (and `logging.ts`, which it transitively
 * loads via `flow-runner.ts` → `judge.ts`) after setting NODE_ENV=production
 * and calling `vi.resetModules()`, so `logging.ts`'s module-scope
 * `isDevelopment` check re-evaluates against the prod env instead of
 * whatever NODE_ENV a prior test file left cached. Registers the real
 * `hcaPlugin` through the real `registerRoutes`.
 *
 * `pino-pretty` is a devDependency, so it's present in this test environment
 * even under NODE_ENV=production — the literal `MODULE_NOT_FOUND` can't be
 * forced here. Spying on every `pino()` construction (same seam
 * `logging.test.ts` uses) and asserting none of them request a pino-pretty
 * transport is the deterministic equivalent: it fails today if any
 * module-load-time logger in the hca boot chain reintroduces the
 * unconditional transport, without depending on node_modules layout.
 */

import Fastify from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import type pino from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import authPlugin from "@/api/plugins/auth";
import errorHandlerPlugin from "@/api/plugins/error-handler";
import type { AppConfig } from "@/config";
import { registerRoutes } from "@/plugins/loader";
import type { SitePlugin } from "@/site-plugin";

const pinoOptionsCalls: pino.LoggerOptions[] = vi.hoisted(() => []);

vi.mock("pino", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import("pino") & { default: typeof pino };
  const spied = (options: pino.LoggerOptions) => {
    pinoOptionsCalls.push(options);
    return actual.default(options);
  };
  return { ...actual, default: spied };
});

const TEST_API_KEY = "server-test-boot-key";

const cfgStub = {
  scraper: { siteBaseUrls: {} },
  plugins: { specifiers: [], strict: false, baseDir: process.cwd() },
} as unknown as AppConfig;

const preservedEnv = {
  NODE_ENV: process.env.NODE_ENV,
  DEV_BYPASS_AUTH: process.env.DEV_BYPASS_AUTH,
  API_KEYS_HASHED: process.env.API_KEYS_HASHED,
};

describe("boot path — hca route registers without a prod pino-pretty crash", () => {
  beforeEach(() => {
    vi.resetModules();
    pinoOptionsCalls.length = 0;
  });

  afterEach(() => {
    if (preservedEnv.NODE_ENV === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = preservedEnv.NODE_ENV;
    if (preservedEnv.DEV_BYPASS_AUTH === undefined) delete process.env.DEV_BYPASS_AUTH;
    else process.env.DEV_BYPASS_AUTH = preservedEnv.DEV_BYPASS_AUTH;
    if (preservedEnv.API_KEYS_HASHED === undefined) delete process.env.API_KEYS_HASHED;
    else process.env.API_KEYS_HASHED = preservedEnv.API_KEYS_HASHED;
  });

  it(
    "POST /v1/hca/run with an empty body returns 400 FIELD_VIOLATION (route present), " +
      "not 404 (route absent because boot crashed)",
    async () => {
      process.env.NODE_ENV = "production";
      delete process.env.DEV_BYPASS_AUTH;
      const bcrypt = await import("bcryptjs");
      process.env.API_KEYS_HASHED = await bcrypt.hash(TEST_API_KEY, 4);

      // Fresh imports under NODE_ENV=production: this is what proves
      // `logging.ts`'s module-scope `isDevelopment` gate (and every
      // module-load-time logger it feeds, reached via hca's flow-runner ->
      // judge.ts import chain) resolves the prod branch rather than a dev
      // branch cached from an earlier test file.
      const { getLogger } = await import("@/lib/logging.js");
      const { hcaPlugin } = await import("@/sites/hca/index.js");
      const { BUILTIN_SITE_PLUGINS } = await import("@/plugins/discover.js");

      expect(
        (BUILTIN_SITE_PLUGINS as SitePlugin<unknown, unknown>[]).some(
          (p) => p.meta.siteId === "hca"
        )
      ).toBe(true);

      const app = Fastify({ loggerInstance: getLogger({ name: "server-boot-test" }) });
      app.setValidatorCompiler(validatorCompiler);
      app.setSerializerCompiler(serializerCompiler);
      await app.register(errorHandlerPlugin);
      await app.register(authPlugin);
      await registerRoutes(app, cfgStub, [hcaPlugin as unknown as SitePlugin<unknown, unknown>]);
      await app.ready();

      const authHeader = { authorization: `Bearer ${TEST_API_KEY}` };

      const hcaResponse = await app.inject({
        method: "POST",
        url: "/v1/hca/run",
        headers: authHeader,
      });
      expect(hcaResponse.statusCode).toBe(400);
      expect(hcaResponse.json()).toMatchObject({
        status: { details: [{ code: 1002, codeDescription: "FIELD_VIOLATION" }] },
      });

      // Control: a path no plugin registers stays 404 — confirms the 400
      // above is because the route exists, not a fluke of the error handler.
      const unknownResponse = await app.inject({
        method: "POST",
        url: "/v1/bogussite/run",
        headers: authHeader,
      });
      expect(unknownResponse.statusCode).toBe(404);
      expect(unknownResponse.json()).toMatchObject({
        status: { details: [{ code: 1005, codeDescription: "RESOURCE_NOT_FOUND" }] },
      });

      const pinoPrettyCalls = pinoOptionsCalls.filter(
        (options) =>
          typeof options.transport === "object" &&
          options.transport !== null &&
          "target" in options.transport &&
          options.transport.target === "pino-pretty"
      );
      expect(pinoPrettyCalls).toEqual([]);

      await app.close();
    }
  );
});
