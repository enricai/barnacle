import type { IncomingMessage, ServerResponse } from "node:http";
import type { FastifyInstance, RawServerDefault } from "fastify";
import type pino from "pino";

import {
  CaptchaEncounteredError,
  EmptyResultsApiError,
  ScrapeFailureError,
  ThrottledRequestError,
} from "@/api/errors";
import { successEnvelope } from "@/api/helpers/envelope";
import { getCachedResponse, getOrCreateInFlight } from "@/cache/response-cache";
import type { AppConfig } from "@/config";
import { prisma } from "@/lib/db/client";
import { extendLogger, getLogger } from "@/lib/logging";
import {
  CaptchaError,
  EmptyResultsError,
  HttpBotChallengeError,
  HttpRateLimitError,
  HttpSchemaError,
  HttpServerError,
  ScraperError,
} from "@/scraper/errors";
import {
  recordFallbackActivation,
  recordHotPathLatency,
  recordHotPathSuccess,
  recordRateLimitRejection,
} from "@/scraper/metrics";
import { runWithSession } from "@/scraper/pool";
import type { SitePlugin, SitePluginContext, SitePluginResult } from "@/site-plugin";
import { examplePlugin } from "@/sites/example";
import type { Logger } from "@/types/logging";

const logger = getLogger({ name: "plugins/loader" });

/**
 * Central registry of all site plugins known to the engine. Adding a new
 * site requires only a new entry here — core's dispatch loop and route
 * registration iterate this array at startup without knowing which plugins
 * exist.
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
 * See src/sites/example/ for the full pattern — contract.ts (hot path +
 * fallback), flows/browser-flow.ts (Stagehand steps), and index.ts (barrel).
 */
export const SITE_PLUGINS: SitePlugin<unknown, unknown>[] = [
  examplePlugin as SitePlugin<unknown, unknown>,
];

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
export async function dispatch<TResult>(
  plugin: SitePlugin<unknown, unknown>,
  payload: unknown,
  context: SitePluginContext,
  options: { forceFallback?: boolean } = {}
): Promise<SitePluginResult<TResult>> {
  let result: SitePluginResult<TResult> | undefined;
  try {
    if (plugin.executeHttp && !options.forceFallback) {
      try {
        const { value: cached, key } = getCachedResponse<SitePluginResult<TResult>>(
          `${context.baseUrl}:${plugin.meta.siteId}`,
          payload
        );
        if (cached) {
          result = cached;
          recordHotPathSuccess(plugin.meta.siteId);
        } else {
          const t0 = Date.now();
          result = await getOrCreateInFlight(
            key,
            // biome-ignore lint/style/noNonNullAssertion: guarded by if (plugin.executeHttp &&...)
            () => plugin.executeHttp!(payload, context) as Promise<SitePluginResult<TResult>>
          );
          recordHotPathLatency(plugin.meta.siteId, Date.now() - t0);
          recordHotPathSuccess(plugin.meta.siteId);
        }
      } catch (httpErr) {
        if (
          httpErr instanceof HttpSchemaError ||
          httpErr instanceof HttpBotChallengeError ||
          httpErr instanceof HttpServerError
        ) {
          logger.warn(
            `hot path failed for ${plugin.meta.siteId} (${httpErr.constructor.name}): ${httpErr.message} — engaging browser fallback`
          );
          recordFallbackActivation(plugin.meta.siteId);
          result = (await runWithSession((session) => plugin.execute(payload, session, context), {
            onRetry: plugin.onRetry,
          })) as SitePluginResult<TResult>;
        } else if (httpErr instanceof HttpRateLimitError) {
          logger.warn(
            `hot path rate-limited for ${plugin.meta.siteId}: ${httpErr.message} — not falling back`
          );
          recordRateLimitRejection(plugin.meta.siteId);
          throw httpErr;
        } else {
          throw httpErr;
        }
      }
    } else {
      if (options.forceFallback) {
        recordFallbackActivation(plugin.meta.siteId);
      }
      result = (await runWithSession((session) => plugin.execute(payload, session, context), {
        onRetry: plugin.onRetry,
      })) as SitePluginResult<TResult>;
    }
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
    if (err instanceof EmptyResultsError) throw new EmptyResultsApiError(err.message);
    if (err instanceof HttpRateLimitError) throw new ThrottledRequestError(err.message);
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
        const forceFallback = request.headers["x-barnacle-force-fallback"] === "true";
        const context: SitePluginContext = {
          baseUrl,
          logger: extendLogger(request.log as unknown as pino.Logger),
          config: cfg,
        };
        const result = await dispatch(plugin, request.body, context, { forceFallback });
        return successEnvelope(result.data as object);
      }
    );
  }

  logger.info(`registered ${SITE_PLUGINS.length} site plugin routes`);
}
