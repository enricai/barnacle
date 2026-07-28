import type { IncomingMessage, ServerResponse } from "node:http";
import fastifyMultipart from "@fastify/multipart";
import { formatISO } from "date-fns";
import type { FastifyInstance, RawServerDefault } from "fastify";
import type pino from "pino";
import { z } from "zod/v4";

import {
  type ApiError,
  CaptchaEncounteredError,
  EmptyResultsApiError,
  FieldViolationError,
  ScrapeFailureError,
  ThrottledRequestError,
  UrlLockedError,
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
import { captureBeaconEvent, createBeaconOutcomeRecorder } from "@/lib/telemetry/beacon-capture";
import { RunTelemetry } from "@/lib/telemetry/run-telemetry";
import { captureSubmissionEnvelope } from "@/lib/telemetry/submission-capture";
import { fireTrackingClick } from "@/lib/tracking-click";
import { BUILTIN_SITE_PLUGINS } from "@/plugins/discover";
import {
  CaptchaError,
  EmptyResultsError,
  HttpBotChallengeError,
  HttpRateLimitError,
  HttpSchemaError,
  HttpServerError,
  HttpUrlLockedError,
  type NeedsUserInfoResult,
  ScraperError,
} from "@/scraper/errors";
import {
  recordFallbackActivation,
  recordHotPathLatency,
  recordHotPathSuccess,
  recordRateLimitRejection,
} from "@/scraper/metrics";
import { runWithSession } from "@/scraper/pool";
import type { BrowserSession } from "@/scraper/session";
import type {
  SitePlugin,
  SitePluginContext,
  SitePluginExtraRoute,
  SitePluginResult,
} from "@/site-plugin";
import { type DispatchMetrics, DispatchMetricsSchema } from "@/types/dispatch-metrics";
import type { Logger } from "@/types/logging";

const logger = getLogger({ name: "plugins/loader" });

/**
 * Params schema for shared `:siteId`-parameterized extra routes. Core validates
 * only the site discriminator; each plugin's own body contract is enforced in
 * the handler after the owning plugin is resolved.
 */
const siteIdRouteParamsSchema = z.object({ siteId: z.string().min(1) });

/**
 * Alias for `BUILTIN_SITE_PLUGINS` kept for backwards compatibility with
 * tests that import `SITE_PLUGINS` directly from this module. New code
 * should reference `BUILTIN_SITE_PLUGINS` from `discover.ts` directly or
 * call `loadAllPlugins` for the composed set.
 */
export const SITE_PLUGINS = BUILTIN_SITE_PLUGINS;

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
  if (err instanceof HttpUrlLockedError) return new UrlLockedError(err.message);
  if (err instanceof ScraperError) return new ScrapeFailureError(err.message);
  return undefined;
}

/** Input to `buildPluginContext` — one per construction site (the `/run` route, an extra route, or a test/integration harness). */
export interface BuildPluginContextInput {
  /** The plugin the context is being built for; supplies `siteId` for both `baseUrl` resolution and the bound beacon recorder. */
  plugin: SitePlugin<unknown, unknown>;
  /** Full app config; also used to resolve `baseUrl` when no override is given. */
  cfg: AppConfig;
  /** Correlation ID for this run, threaded into telemetry and the bound beacon recorder. */
  requestId: string;
  /** Request-scoped logger, already extended by the caller (`extendLogger` for real requests). */
  logger: Logger;
  /** Overrides the `cfg.scraper.siteBaseUrls` / `plugin.meta.defaultBaseUrl` resolution; used by the integration-test harness, which supplies its own job-derived `baseUrl`. */
  baseUrl?: string;
}

/**
 * Builds the `SitePluginContext` core injects into every plugin call. Single
 * shared factory for all three construction sites (`/run` route, extra
 * routes, `runIntegrationJob`) so a new context member is a one-line change
 * here instead of three drifting literals.
 */
export function buildPluginContext(input: BuildPluginContextInput): SitePluginContext {
  const { plugin, cfg, requestId, logger, baseUrl } = input;
  return {
    baseUrl:
      baseUrl ?? cfg.scraper.siteBaseUrls[plugin.meta.siteId] ?? plugin.meta.defaultBaseUrl ?? "",
    logger,
    config: cfg,
    requestId,
    metricsCollector: new MetricsCollector(),
    recordBeaconOutcome: createBeaconOutcomeRecorder({ requestId, siteId: plugin.meta.siteId }),
    telemetry: new RunTelemetry(),
  };
}

/**
 * Wraps a session-scoped plugin call so the acquired session's identity and
 * outbound IP are recorded onto `context.telemetry` regardless of whether the
 * call succeeds or throws. `runWithSession` (`src/scraper/pool.ts`) creates
 * and closes the `BrowserSession` entirely inside its own callback — this is
 * the only place still holding a reference to it, so it is the only place
 * that can still query `getOutboundIp()` before the session is gone.
 * Tolerates a null/absent session (the hot path never acquires one; some
 * pool test doubles pass null) and an absent `getOutboundIp` (Steel has no
 * accessor) by recording `ip: null, ipCapturedAt: null` in either case.
 */
async function withSessionTelemetry<T>(
  session: BrowserSession | null,
  context: SitePluginContext,
  run: () => Promise<T>
): Promise<T> {
  try {
    return await run();
  } finally {
    if (session) {
      const ip = (await session.getOutboundIp?.()) ?? null;
      context.telemetry.recordSession({
        sessionId: session.sessionId,
        provider: session.provider,
        ip,
        ipCapturedAt: formatISO(new Date()),
      });
    }
  }
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
      (session) =>
        withSessionTelemetry(session, context, () => plugin.execute(payload, session, context)),
      { onRetry: plugin.onRetry, maxAttempts: plugin.meta.maxAttempts },
      plugin.meta.taskTimeoutMs,
      {
        advancedStealth: plugin.meta.advancedStealth,
        ...(plugin.meta.browserbaseSessionCreateParams && {
          browserbaseSessionCreateParams: plugin.meta.browserbaseSessionCreateParams,
        }),
      }
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
        (session) =>
          withSessionTelemetry(session, context, () => plugin.execute(payload, session, context)),
        { onRetry: plugin.onRetry, maxAttempts: plugin.meta.maxAttempts },
        plugin.meta.taskTimeoutMs,
        {
          advancedStealth: plugin.meta.advancedStealth,
          ...(plugin.meta.browserbaseSessionCreateParams && {
            browserbaseSessionCreateParams: plugin.meta.browserbaseSessionCreateParams,
          }),
        }
      )) as SitePluginResult<TResult>;
    }
    if (httpErr instanceof HttpRateLimitError) {
      logger.warn(
        `hot path rate-limited for ${plugin.meta.siteId}: ${httpErr.message} — not falling back`
      );
      recordRateLimitRejection(plugin.meta.siteId);
      recordDdRateLimit(plugin.meta.siteId);
    }
    if (httpErr instanceof HttpUrlLockedError) {
      logger.warn(
        `hot path url-locked for ${plugin.meta.siteId}: ${httpErr.message} — not falling back`
      );
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
 * Best-effort wrapper around `captureBeaconEvent`, matching `emitEnvelopeSafely`'s
 * defense: `captureBeaconEvent` already swallows its own write errors, but a
 * test double or unexpected synchronous throw must still never propagate into
 * dispatch's success path.
 */
async function emitBeaconSafely(input: Parameters<typeof captureBeaconEvent>[0]): Promise<void> {
  try {
    await captureBeaconEvent(input);
  } catch (err) {
    logger.warn(`beacon event emit failed: ${toErrorMessage(err)}`);
  }
}

/**
 * Merges a plugin's pre-run `extractJoinKeys(payload)` result with whatever
 * it attached mid-run via `context.telemetry.addJoinKeys()`, run-attached
 * fields winning on collision. Stays `null` (not `{}`) when both sources are
 * empty so the envelope's `joinKeys: null` precedent holds for a plugin that
 * uses neither mechanism.
 */
function mergeJoinKeys(
  extracted: Record<string, unknown> | null,
  attached: Record<string, unknown> | null
): Record<string, unknown> | null {
  if (!extracted && !attached) return null;
  return { ...extracted, ...attached };
}

/**
 * Maps `RunTelemetry`'s collector-shaped session record (`sessionId`) onto
 * the durable envelope's persisted shape (`id`) documented in
 * `docs/telemetry-and-judging.md`'s "session" field.
 */
function toEnvelopeSession(
  session: ReturnType<SitePluginContext["telemetry"]["snapshot"]>["session"]
): { id: string; provider: string; ip: string | null; ipCapturedAt: string | null } | null {
  if (!session) return null;
  return {
    id: session.sessionId,
    provider: session.provider,
    ip: session.ip,
    ipCapturedAt: session.ipCapturedAt,
  };
}

/**
 * Runs a single plugin submission end-to-end. Tries the direct-HTTP hot path
 * first when the plugin supplies `executeHttp`; on `HttpSchemaError`,
 * `HttpBotChallengeError`, or `HttpServerError` falls back to the Stagehand
 * browser path. Records metrics on each branch so ops dashboards can alert on
 * rising fallback rates. Emits a `submission-envelope` telemetry record on
 * both success and failure — the durable source-of-truth for "what did we
 * submit for jobId X and did it succeed." Calls the plugin's own
 * `extractJoinKeys` (if declared) once and stamps the opaque result onto both
 * the submission envelope and the tracking click so a run's submit and
 * beacon-fire records can be joined, without core knowing what the keys mean.
 * A plugin that declares `extractJoinKeys` is asserting it manages its own
 * post-submit attribution navigation, so core's automatic `TrackingUrl` fire
 * is skipped for it — firing both would open two independent sessions
 * against the same tracking URL, which can orphan the plugin's own
 * click-to-session association with its attribution vendor. Either way — no
 * usable `TrackingUrl`, or a plugin that manages its own nav — the skipped
 * case still records a `beaconStatus: "skipped"` record instead of firing
 * the tracking click, so "no beacon was ever applicable" is distinguishable
 * from "a beacon was attempted and never recorded an outcome"; the record's
 * `trackingUrl` field is preserved (not nulled) when a real URL was present
 * but delegated, so the two skip reasons stay distinguishable from each
 * other too. Maps scraper errors to the API error hierarchy so callers
 * receive typed, client-readable errors instead of raw scraper internals.
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
  const extractedJoinKeys = plugin.extractJoinKeys?.(payload) ?? null;
  const managesOwnTracking = !!plugin.extractJoinKeys;

  recordDdAttempt(ddTags);

  try {
    const result = await runPluginPipeline<TResult>(plugin, payload, context, options);
    const durationMs = Date.now() - startedAt;

    // Short-circuit: the hot path signalled that the user must supply additional
    // information (OTP or missing profile fields). This is not a success — skip
    // the submission envelope and tracking click so the challenge state is not
    // recorded as a completed application.
    if ((result.data as NeedsUserInfoResult).needsUserInfo === true) {
      result.metrics = context.metricsCollector.finalize(pathTag);
      return result;
    }

    recordDdSuccess(ddTags);
    recordDdDuration(ddTags, durationMs);

    const metrics = context.metricsCollector.finalize(pathTag);
    result.metrics = metrics;

    const successSnapshot = context.telemetry.snapshot();
    const joinKeys = mergeJoinKeys(extractedJoinKeys, successSnapshot.joinKeys);

    await emitEnvelopeSafely({
      siteId: plugin.meta.siteId,
      requestId: context.requestId,
      joinKeys,
      session: toEnvelopeSession(successSnapshot.session),
      inboundPayload: payload,
      status: "submitted",
      auditPayload: result.auditPayload ?? result.data,
      errorMessage: null,
      durationMs,
    });

    const rawTrackingUrl = (payload as Record<string, unknown>)?.TrackingUrl;
    const trackingUrl =
      typeof rawTrackingUrl === "string" && rawTrackingUrl.length > 0 ? rawTrackingUrl : null;
    if (!managesOwnTracking && trackingUrl) {
      fireTrackingClick(trackingUrl, plugin.meta.siteId, {
        requestId: context.requestId,
        joinKeys,
      });
    } else {
      await emitBeaconSafely({
        requestId: context.requestId,
        siteId: plugin.meta.siteId,
        joinKeys,
        beaconStatus: "skipped",
        // Preserved (not nulled) when the plugin manages its own tracking
        // nav and a URL was present, so the sink can distinguish "no URL
        // was ever applicable" (trackingUrl: null) from "a URL was present
        // but a different, plugin-owned navigation used it instead"
        // (trackingUrl: <the URL>) — both cases hit this branch, but only
        // the latter had a real URL to report.
        trackingUrl,
        durationMs: 0,
      });
    }

    return result;
  } catch (err) {
    const durationMs = Date.now() - startedAt;
    const errorType = classifyDispatchError(err);
    const failureTags: FailureDispatchTags = { ...ddTags, error_type: errorType };

    recordDdFailure(failureTags);
    recordDdDuration(ddTags, durationMs);

    const metrics = context.metricsCollector.finalize(pathTag);

    const errorSnapshot = context.telemetry.snapshot();
    const joinKeys = mergeJoinKeys(extractedJoinKeys, errorSnapshot.joinKeys);

    await emitEnvelopeSafely({
      siteId: plugin.meta.siteId,
      requestId: context.requestId,
      joinKeys,
      session: toEnvelopeSession(errorSnapshot.session),
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
  if (err instanceof HttpUrlLockedError) return "url_locked";
  if (err instanceof HttpSchemaError) return "schema_drift";
  if (err instanceof HttpServerError) return "server_error";
  if (err instanceof CaptchaError) return "captcha";
  if (err instanceof EmptyResultsError) return "empty_results";
  if (err instanceof ScraperError) return "scraper_generic";
  return "unknown";
}

const ResponseEnvelopeSchema = z.object({
  status: z.object({
    httpStatus: z.string(),
    dateTime: z.string(),
    details: z.array(z.unknown()),
  }),
  metrics: DispatchMetricsSchema.optional(),
});

function buildEnvelopedResponseSchema(pluginSchema: z.ZodType): z.ZodType {
  if (pluginSchema instanceof z.ZodObject) {
    return ResponseEnvelopeSchema.extend(pluginSchema.shape).passthrough();
  }
  return z.unknown();
}

/**
 * Registers one Fastify POST route per plugin plus any extra routes declared
 * in `plugin.meta.extraRoutes`. Called from `buildServer()` so `server.ts`
 * stays site-agnostic — it delegates all plugin-specific route knowledge
 * (path, schema, dispatch) to this module instead of maintaining an inline loop.
 */
export async function registerRoutes(
  app: FastifyInstance<RawServerDefault, IncomingMessage, ServerResponse, Logger>,
  cfg: AppConfig,
  plugins: SitePlugin<unknown, unknown>[]
): Promise<void> {
  const needsMultipart = plugins.some(
    (p) => p.meta.multipart === true || p.meta.extraRoutes?.some((r) => r.multipart === true)
  );
  if (needsMultipart) {
    await app.register(fastifyMultipart, { attachFieldsToBody: "keyValues" });
  }

  for (const plugin of plugins) {
    const routePath = plugin.meta.routeOverride ?? `/v1/${plugin.meta.siteId}/run`;

    app.post(
      routePath,
      {
        onRequest: [app.authenticate],
        schema: {
          body: plugin.meta.bodySchema,
          response: { 200: buildEnvelopedResponseSchema(plugin.meta.responseSchema) },
          ...(plugin.meta.multipart === true ? { consumes: ["multipart/form-data"] } : {}),
        },
      },
      async (request) => {
        const forceFallback = request.headers["x-barnacle-execution"] === "browser";
        const context = buildPluginContext({
          plugin,
          cfg,
          requestId: request.id,
          logger: extendLogger(request.log as unknown as pino.Logger),
        });
        const result = await dispatch(plugin, request.body, context, { forceFallback });
        return successEnvelope({
          ...(result.data as object),
          ...(result.metrics && { metrics: result.metrics }),
        });
      }
    );

    logger.info(`${plugin.meta.siteId} → ${routePath} (loaded)`);
  }

  registerExtraRoutes(app, cfg, plugins);
}

/**
 * Fastify registers each `method+url` exactly once, but several plugins declare
 * the SAME parameterized extra route (e.g. `POST /v1/:siteId/resume` for two
 * or more sibling plugins). Registering per-plugin throws
 * `FST_ERR_DUPLICATED_ROUTE` and crashes boot.
 *
 * We group extra routes by `method+path` and register each unique path once.
 * A path claimed by a single plugin registers with that plugin's own body/params
 * schema and handler (unchanged behavior). A path shared by multiple plugins is
 * necessarily `:siteId`-parameterized: core validates only the `:siteId` param,
 * then resolves the owning plugin from it at request time and validates the body
 * against that plugin's own `bodySchema`, because sibling plugins sharing a path
 * carry different body contracts.
 */
function registerExtraRoutes(
  app: FastifyInstance<RawServerDefault, IncomingMessage, ServerResponse, Logger>,
  cfg: AppConfig,
  plugins: SitePlugin<unknown, unknown>[]
): void {
  const byMethodPath = new Map<
    string,
    {
      method: Uppercase<SitePluginExtraRoute["method"]>;
      path: string;
      multipart: boolean;
      owners: Map<string, SitePlugin<unknown, unknown>>;
    }
  >();

  for (const plugin of plugins) {
    for (const route of plugin.meta.extraRoutes ?? []) {
      const method = route.method.toUpperCase() as Uppercase<SitePluginExtraRoute["method"]>;
      const key = `${method} ${route.path}`;
      const entry = byMethodPath.get(key) ?? {
        method,
        path: route.path,
        multipart: false,
        owners: new Map<string, SitePlugin<unknown, unknown>>(),
      };
      entry.multipart = entry.multipart || route.multipart === true;
      entry.owners.set(plugin.meta.siteId, plugin);
      byMethodPath.set(key, entry);
    }
  }

  for (const entry of byMethodPath.values()) {
    const shared = entry.owners.size > 1;

    const findRoute = (plugin: SitePlugin<unknown, unknown>): SitePluginExtraRoute | undefined =>
      plugin.meta.extraRoutes?.find(
        (r) => r.method.toUpperCase() === entry.method && r.path === entry.path
      );

    const soleOwner = shared ? undefined : [...entry.owners.values()][0];
    const soleRoute = soleOwner ? findRoute(soleOwner) : undefined;

    app.route({
      method: entry.method,
      url: entry.path,
      onRequest: [app.authenticate],
      schema: {
        ...(shared ? { params: siteIdRouteParamsSchema } : {}),
        ...(!shared && soleRoute?.bodySchema ? { body: soleRoute.bodySchema } : {}),
        ...(!shared && soleRoute?.paramsSchema ? { params: soleRoute.paramsSchema } : {}),
        ...(entry.multipart ? { consumes: ["multipart/form-data"] } : {}),
      },
      handler: async (request) => {
        const siteId = (request.params as { siteId?: string }).siteId ?? "";
        const plugin = shared ? entry.owners.get(siteId) : soleOwner;
        if (!plugin) {
          throw new FieldViolationError(
            `no plugin registered for siteId ${JSON.stringify(siteId)} on ${entry.method} ${entry.path}`
          );
        }
        const route = findRoute(plugin);
        if (!route) {
          throw new FieldViolationError(
            `plugin ${plugin.meta.siteId} has no handler for ${entry.method} ${entry.path}`
          );
        }

        // Fastify already validated the body for single-owner routes (schema.body
        // above); shared routes defer body validation to here, against the
        // resolved plugin's own contract.
        const body =
          shared && route.bodySchema ? route.bodySchema.parse(request.body) : request.body;
        const context = buildPluginContext({
          plugin,
          cfg,
          requestId: request.id,
          logger: extendLogger(request.log as unknown as pino.Logger),
        });
        const result = await route.handler(
          {
            body,
            params: request.params as Record<string, string>,
            log: request.log as unknown as Logger,
          },
          context
        );
        return route.envelope === false ? result : successEnvelope(result as object);
      },
    });

    logger.info(
      `${entry.path} → [${[...entry.owners.keys()].join(", ")}] via ${entry.method} (loaded)`
    );
  }
}
