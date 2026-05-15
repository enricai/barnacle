import type { IncomingMessage, ServerResponse } from "node:http";
import type { FastifyInstance, RawServerDefault } from "fastify";

import { CaptchaEncounteredError, ScrapeFailureError } from "@/api/errors";
import { successEnvelope } from "@/api/helpers/envelope";
import type { AppConfig } from "@/config";
import { prisma } from "@/lib/db/client";
import { getLogger } from "@/lib/logging";
import { CaptchaError, ScraperError } from "@/scraper/errors";
import { runWithSession } from "@/scraper/pool";
import type { SitePlugin, SitePluginContext, SitePluginResult } from "@/site-plugin";
import { femaPlugin as loadedPlugin } from "@/sites/fema/index";
import type { Logger } from "@/types/logging";

const logger = getLogger({ name: "plugins/loader" });

/**
 * Central registry of all site plugins known to the engine. Adding a new
 * site requires only a new entry here — core's dispatch loop and route
 * registration iterate this array at startup without knowing which plugins
 * exist.
 */
export const SITE_PLUGINS: SitePlugin<unknown, unknown>[] = [
  loadedPlugin as unknown as SitePlugin<unknown, unknown>,
];

/**
 * Runs a single plugin submission end-to-end: acquires a browser session,
 * calls `plugin.execute()`, writes a `SiteSubmission` audit row on both
 * success and failure, and maps scraper errors to the VPS error hierarchy
 * so callers receive typed, client-readable errors instead of raw scraper
 * internals.
 */
export async function dispatch<TResult>(
  plugin: SitePlugin<unknown, unknown>,
  payload: unknown,
  context: SitePluginContext
): Promise<SitePluginResult<TResult>> {
  let result: SitePluginResult<TResult> | undefined;
  try {
    result = (await runWithSession((session) =>
      plugin.execute(payload, session, context)
    )) as SitePluginResult<TResult>;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    try {
      await prisma.siteSubmission.create({
        data: {
          siteId: plugin.meta.siteId,
          status: "error",
          payload: { error: message, siteId: plugin.meta.siteId },
        },
      });
    } catch (dbErr) {
      logger.warn(
        `audit write failed after scrape error: ${dbErr instanceof Error ? dbErr.message : String(dbErr)}`
      );
    }
    if (err instanceof CaptchaError) throw new CaptchaEncounteredError(err.message);
    if (err instanceof ScraperError) throw new ScrapeFailureError(err.message);
    throw err;
  }

  try {
    await prisma.siteSubmission.create({
      data: {
        siteId: plugin.meta.siteId,
        status: "submitted",
        payload: (result.auditPayload ?? result.data) as object,
      },
    });
  } catch (dbErr) {
    logger.warn(
      `audit write failed after successful scrape: ${dbErr instanceof Error ? dbErr.message : String(dbErr)}`
    );
  }

  return result;
}

/**
 * Registers one Fastify POST route per plugin in `SITE_PLUGINS`. Called
 * from `buildServer()` so `server.ts` stays site-agnostic — it delegates
 * all plugin-specific route knowledge (path, schema, dispatch) to this
 * module instead of maintaining an inline loop.
 */
export async function registerRoutes(
  app: FastifyInstance<RawServerDefault, IncomingMessage, ServerResponse, Logger>,
  cfg: AppConfig
): Promise<void> {
  for (const plugin of SITE_PLUGINS) {
    const routePath = plugin.meta.routeOverride ?? `/v1/${plugin.meta.siteId}/run`;
    const baseUrl =
      cfg.scraper.siteBaseUrls[plugin.meta.siteId] ?? plugin.meta.defaultBaseUrl ?? "";

    app.post(
      routePath,
      {
        onRequest: [app.authenticate],
        schema: {
          body: plugin.meta.bodySchema,
          response: { 200: plugin.meta.responseSchema },
        },
      },
      async (request) => {
        const context: SitePluginContext = {
          baseUrl,
          logger: request.log as unknown as Logger,
          config: cfg,
        };
        const result = await dispatch(plugin, request.body, context);
        return successEnvelope(result.data as object);
      }
    );
  }

  logger.info(`registered ${SITE_PLUGINS.length} site plugin routes`);
}
