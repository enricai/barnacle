import type { IncomingMessage, ServerResponse } from "node:http";
import type { FastifyInstance, RawServerDefault } from "fastify";
import type { AppConfig } from "../config";
import type { SitePlugin, SitePluginContext, SitePluginResult } from "../site-plugin";
import type { Logger } from "../types/logging";
/**
 * Central registry of all site plugins known to the engine. Adding a new
 * site requires only a new entry here — core's dispatch loop and route
 * registration iterate this array at startup without knowing which plugins
 * exist. Ships empty by default; no reference plugin is bundled in-tree.
 *
 * Onboarding a new site (two steps):
 *
 *   1. Import the plugin and push it:
 *        import { myPlugin } from "@/sites/my-site";
 *        SITE_PLUGINS.push(myPlugin as SitePlugin<unknown, unknown>);
 *
 *   2. Add it to the nightly smoke-test invocation in CI:
 *        pnpm run smoke -- --site my-site --payload '{"query":"test"}'
 *
 * Each site plugin lives under src/sites/<siteId>/ as a self-contained
 * folder: contract.ts (meta, schemas, hot path + fallback), flows/ (Stagehand
 * steps for the browser fallback), and index.ts (barrel export). See
 * src/site-plugin.ts for the SitePlugin interface every plugin must implement.
 */
export declare const SITE_PLUGINS: SitePlugin<unknown, unknown>[];
/**
 * Runs a single plugin submission end-to-end. Tries the direct-HTTP hot path
 * first when the plugin supplies `executeHttp`; on `HttpSchemaError`,
 * `HttpBotChallengeError`, or `HttpServerError` falls back to the Stagehand
 * browser path. Records
 * metrics on each branch so ops dashboards can alert on rising fallback rates.
 * Writes a `SiteSubmission` audit row on both success and failure, and maps
 * scraper errors to the API error hierarchy so callers receive typed,
 * client-readable errors instead of raw scraper internals.
 */
export declare function dispatch<TResult>(plugin: SitePlugin<unknown, unknown>, payload: unknown, context: SitePluginContext, options?: {
    forceFallback?: boolean;
}): Promise<SitePluginResult<TResult>>;
/**
 * Registers one Fastify POST route per plugin in `SITE_PLUGINS`. Called
 * from `buildServer()` so `server.ts` stays site-agnostic — it delegates
 * all plugin-specific route knowledge (path, schema, dispatch) to this
 * module instead of maintaining an inline loop.
 */
export declare function registerRoutes(app: FastifyInstance<RawServerDefault, IncomingMessage, ServerResponse, Logger>, cfg: AppConfig): Promise<void>;
