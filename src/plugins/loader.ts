import type { IncomingMessage, ServerResponse } from "node:http";
import fastifyMultipart from "@fastify/multipart";
import type { FastifyInstance, RawServerDefault } from "fastify";
import type pino from "pino";

import {
  type ApiError,
  CaptchaEncounteredError,
  EmptyResultsApiError,
  ScrapeFailureError,
  ThrottledRequestError,
} from "@/api/errors";
import { successEnvelope } from "@/api/helpers/envelope";
import { getCachedResponse, getOrCreateInFlight } from "@/cache/response-cache";
import type { AppConfig } from "@/config";
import {
  type FailureDispatchTags,
  recordDdAttempt,
  recordDdDuration,
  recordDdFailure,
  recordDdFallback,
  recordDdRateLimit,
  recordDdSuccess,
} from "@/lib/dd-metrics";
import { MetricsCollector } from "@/lib/dispatch-metrics";
import { toErrorMessage } from "@/lib/errors";
import { extendLogger, getLogger } from "@/lib/logging";
import { captureSubmissionEnvelope } from "@/lib/telemetry/submission-capture";
import { fireTrackingClick } from "@/lib/tracking-click";
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
import type { DispatchMetrics } from "@/types/dispatch-metrics";
import type { Logger } from "@/types/logging";

const logger = getLogger({ name: "plugins/loader" });

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
export const SITE_PLUGINS: SitePlugin<unknown, unknown>[] = [];

/**
 * Pure mapping from scraper-internal errors to the public ApiError hierarchy.
 *
 * Exists so dispatch()'s catch block stays a short tail of guard clauses —
 * the if-instanceof chain captures the entire scraper-to-wire error contract
 * in one place. Returns `undefined` when the caller should re-throw the
 * original error (plain Error or anything outside the ScraperError tree).
 */
function toApiError(err: unknown): ApiError | undefined {
  if (err instanceof CaptchaError) return new CaptchaEncounteredError(err.message);
  if (err instanceof EmptyResultsError) return new EmptyResultsApiError(err.message);
  if (err instanceof HttpRateLimitError) return new ThrottledRequestError(err.message);
  if (err instanceof ScraperError) return new ScrapeFailureError(err.message);
  return undefined;
}

/**
 * Runs the hot path (when available) + fallback pipeline for a single
 * submission. Extracted so dispatch() reads as a linear "run pipeline,
 * record audit, return" sequence rather than a `let result` mutated across
 * three branches.
 */
async function runPluginPipeline<TResult>(
  plugin: SitePlugin<unknown, unknown>,
  payload: unknown,
  context: SitePluginContext,
  options: { forceFallback?: boolean }
): Promise<SitePluginResult<TResult>> {
  if (!plugin.executeHttp || options.forceFallback) {
    if (options.forceFallback) {
      recordFallbackActivation(plugin.meta.siteId);
      recordDdFallback(plugin.meta.siteId);
    }
    return (await runWithSession(
      (session) => plugin.execute(payload, session, context),
      { onRetry: plugin.onRetry },
      plugin.meta.taskTimeoutMs,
      { advancedStealth: plugin.meta.advancedStealth }
    )) as SitePluginResult<TResult>;
  }

  try {
    const { value: cached, key } = getCachedResponse<SitePluginResult<TResult>>(
      `${context.baseUrl}:${plugin.meta.siteId}`,
      payload
    );
    if (cached) {
      recordHotPathSuccess(plugin.meta.siteId);
      return cached;
    }
    const t0 = Date.now();
    const fresh = await getOrCreateInFlight(
      key,
      // biome-ignore lint/style/noNonNullAssertion: guarded by !plugin.executeHttp above
      () => plugin.executeHttp!(payload, context) as Promise<SitePluginResult<TResult>>
    );
    recordHotPathLatency(plugin.meta.siteId, Date.now() - t0);
    recordHotPathSuccess(plugin.meta.siteId);
    return fresh;
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
      recordDdFallback(plugin.meta.siteId);
      return (await runWithSession(
        (session) => plugin.execute(payload, session, context),
        { onRetry: plugin.onRetry },
        plugin.meta.taskTimeoutMs,
        { advancedStealth: plugin.meta.advancedStealth }
      )) as SitePluginResult<TResult>;
    }
    if (httpErr instanceof HttpRateLimitError) {
      logger.warn(
        `hot path rate-limited for ${plugin.meta.siteId}: ${httpErr.message} — not falling back`
      );
      recordRateLimitRejection(plugin.meta.siteId);
      recordDdRateLimit(plugin.meta.siteId);
    }
    throw httpErr;
  }
}

/**
 * Best-effort wrapper around `captureSubmissionEnvelope`. The helper itself
 * already swallows write errors, but defending dispatch against a misbehaving
 * sink (or a test mock that bypasses the helper's internal try/catch) keeps
 * the audit emission contractually non-breaking: a sink failure must never
 * propagate into the request path.
 */
async function emitEnvelopeSafely(
  input: Parameters<typeof captureSubmissionEnvelope>[0]
): Promise<void> {
  try {
    await captureSubmissionEnvelope(input);
  } catch (err) {
    logger.warn(`submission envelope emit failed: ${toErrorMessage(err)}`);
  }
}

/**
 * Runs a single plugin submission end-to-end. Tries the direct-HTTP hot path
 * first when the plugin supplies `executeHttp`; on `HttpSchemaError`,
 * `HttpBotChallengeError`, or `HttpServerError` falls back to the Stagehand
 * browser path. Records metrics on each branch so ops dashboards can alert on
 * rising fallback rates. Emits a `submission-envelope` telemetry record on
 * both success and failure — the durable source-of-truth for "what did we
 * submit for jobId X and did it succeed." Maps scraper errors to the API
 * error hierarchy so callers receive typed, client-readable errors instead
 * of raw scraper internals.
 */
export async function dispatch<TResult>(
  plugin: SitePlugin<unknown, unknown>,
  payload: unknown,
  context: SitePluginContext,
  options: { forceFallback?: boolean } = {}
): Promise<SitePluginResult<TResult>> {
  const startedAt = Date.now();
  const hasHttpPath = !!plugin.executeHttp && !options.forceFallback;
  const pathTag: "http" | "browser" = hasHttpPath ? "http" : "browser";
  const ddTags = { site: plugin.meta.siteId, path: pathTag };

  recordDdAttempt(ddTags);

  try {
    const result = await runPluginPipeline<TResult>(plugin, payload, context, options);
    const durationMs = Date.now() - startedAt;

    recordDdSuccess(ddTags);
    recordDdDuration(ddTags, durationMs);

    const metrics = context.metricsCollector.finalize(pathTag);
    result.metrics = metrics;

    await emitEnvelopeSafely({
      siteId: plugin.meta.siteId,
      requestId: context.requestId,
      inboundPayload: payload,
      status: "submitted",
      auditPayload: result.auditPayload ?? result.data,
      errorMessage: null,
      durationMs,
    });

    const trackingUrl = (payload as Record<string, unknown>)?.TrackingUrl;
    if (typeof trackingUrl === "string" && trackingUrl.length > 0) {
      fireTrackingClick(trackingUrl, plugin.meta.siteId);
    }

    return result;
  } catch (err) {
    const durationMs = Date.now() - startedAt;
    const errorType = classifyDispatchError(err);
    const failureTags: FailureDispatchTags = { ...ddTags, error_type: errorType };

    recordDdFailure(failureTags);
    recordDdDuration(ddTags, durationMs);

    const metrics = context.metricsCollector.finalize(pathTag);

    await emitEnvelopeSafely({
      siteId: plugin.meta.siteId,
      requestId: context.requestId,
      inboundPayload: payload,
      status: "error",
      auditPayload: null,
      errorMessage: toErrorMessage(err),
      durationMs,
    });

    const apiErr = toApiError(err);
    if (apiErr) {
      (apiErr as unknown as { metrics: DispatchMetrics }).metrics = metrics;
      throw apiErr;
    }
    (err as unknown as { metrics: DispatchMetrics }).metrics = metrics;
    throw err;
  }
}

/** Maps errors to DogStatsD-friendly classification strings. */
function classifyDispatchError(err: unknown): string {
  if (err instanceof HttpBotChallengeError) return "bot_challenge";
  if (err instanceof HttpRateLimitError) return "rate_limit";
  if (err instanceof HttpSchemaError) return "schema_drift";
  if (err instanceof HttpServerError) return "server_error";
  if (err instanceof CaptchaError) return "captcha";
  if (err instanceof EmptyResultsError) return "empty_results";
  if (err instanceof ScraperError) return "scraper_generic";
  return "unknown";
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
  if (SITE_PLUGINS.some((p) => p.meta.multipart === true)) {
    await app.register(fastifyMultipart, { attachFieldsToBody: "keyValues" });
  }

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
          ...(plugin.meta.multipart === true ? { consumes: ["multipart/form-data"] } : {}),
        },
      },
      async (request) => {
        const forceFallback = request.headers["x-barnacle-force-fallback"] === "true";
        const context: SitePluginContext = {
          baseUrl,
          logger: extendLogger(request.log as unknown as pino.Logger),
          config: cfg,
          requestId: request.id,
          metricsCollector: new MetricsCollector(),
        };
        const result = await dispatch(plugin, request.body, context, { forceFallback });
        return successEnvelope({
          ...(result.data as object),
          ...(result.metrics && { metrics: result.metrics }),
        });
      }
    );
  }

  logger.info(`registered ${SITE_PLUGINS.length} site plugin routes`);
}
