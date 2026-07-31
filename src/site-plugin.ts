/**
 * Contract every site plugin implements and that core's dispatch layer consumes.
 * Lives at the top of `src/` alongside `config.ts` and `server.ts` because it
 * is engine-level infrastructure, not site-specific logic — any new site drops
 * a plugin into `src/sites/<id>/` and satisfies this interface without touching
 * core.
 *
 * All imports are type-only: this file has zero runtime side effects and is safe
 * to import from any layer without pulling in browser or config initialization.
 */

import type { ZodType } from "zod/v4";

import type { AppConfig } from "@/config";
import type { MetricsCollector } from "@/lib/dispatch-metrics";
import type { ScraperError } from "@/scraper/errors";
import type { BrowserSession } from "@/scraper/session";
import type { BrowserbaseSessionCreateParams } from "@/scraper/session-shared";
import type { DispatchMetrics } from "@/types/dispatch-metrics";
import type { Logger } from "@/types/logging";

/**
 * Minimal request surface exposed to extra-route handlers. Core passes a
 * Fastify `FastifyRequest` here; the interface is narrowed so handlers stay
 * decoupled from Fastify internals and testable with plain objects.
 */
export interface SitePluginExtraRouteRequest<TBody = unknown, TParams = Record<string, string>> {
  /** Parsed and Zod-validated request body. Present when `bodySchema` is set on the route. */
  body: TBody;
  /** Parsed and Zod-validated route params. Present when `paramsSchema` is set on the route. */
  params: TParams;
  /** Request-scoped Fastify/Pino logger. */
  log: Logger;
}

/**
 * Declares one extra non-run route a plugin owns. Core iterates
 * `meta.extraRoutes` at startup and registers each as an authenticated Fastify
 * route, building the same `SitePluginContext` it uses for `/run`.
 *
 * Error rendering is always delegated to the app-level `errorHandlerPlugin` —
 * handlers throw typed `ApiError`s; never return error shapes directly.
 * `envelope` governs only the success reply shape.
 */
export interface SitePluginExtraRoute {
  /** HTTP method for the route (lowercase). */
  method: "get" | "post" | "put" | "patch" | "delete";
  /**
   * Absolute route path (e.g. `/v1/my-site/trigger-otp`). Core registers it
   * verbatim — no prefix is added.
   */
  path: string;
  /** Zod schema for the request body. When absent, the body is not validated. */
  bodySchema?: ZodType;
  /** Zod schema for route path params. When absent, params are not validated. */
  paramsSchema?: ZodType;
  /**
   * When true, the route accepts `multipart/form-data`. Core ensures
   * `@fastify/multipart` is registered when any plugin declares a multipart
   * extra route.
   */
  multipart?: boolean;
  /**
   * When false, the handler's return value is sent as-is (raw reply). When
   * true or absent, core wraps the return value in the standard success
   * envelope. Defaults to true.
   */
  envelope?: boolean;
  /** Handles the request and returns the (pre-envelope) response body. */
  handler(request: SitePluginExtraRouteRequest, context: SitePluginContext): Promise<unknown>;
}

/**
 * Static metadata that core reads at startup to register the plugin's Fastify
 * route. Separating metadata from `execute()` lets the loader validate config
 * and build routes before any session is acquired.
 */
export interface SitePluginMeta {
  /** Stable identifier used as the `config.scraper.siteBaseUrls` lookup key. */
  siteId: string;
  /** Human-readable label used in logs and Swagger docs. */
  displayName: string;
  /** Zod schema for the route request body — validated by core before execute(). */
  bodySchema: ZodType;
  /** Zod schema for the successful response body — drives the Swagger response shape. */
  responseSchema: ZodType;
  /**
   * Full route path override. When set, the loader uses this verbatim instead
   * of `/v1/{siteId}/run`. Intended for legacy compatibility where an existing
   * client contract cannot change.
   */
  routeOverride?: string;
  /**
   * Fallback base URL used by the loader when `config.scraper.siteBaseUrls[siteId]`
   * is absent. Plugins read their own env vars here so core config stays generic.
   */
  defaultBaseUrl?: string;
  /**
   * Per-task hard timeout in ms passed to the pool's runWithSession.
   * Overrides the pool's 60-minute default. Only set when a plugin needs
   * a shorter ceiling than the default.
   */
  taskTimeoutMs?: number;
  /**
   * Max attempts (including the first try) passed to runWithSession's retry
   * policy. Overrides the pool's default of 3. Without this, the per-run
   * ceiling is `3 × taskTimeoutMs` regardless of the plugin's stated timeout —
   * set to 1 so taskTimeoutMs is a real per-run cap, not one third of it.
   */
  maxAttempts?: number;
  /**
   * When true, the loader registers the route to accept `multipart/form-data`
   * via `@fastify/multipart` in `attachFieldsToBody: 'keyValues'` mode. Text
   * parts arrive as strings on `request.body`; file parts arrive as `Buffer`s.
   * Generator emits this for flows whose recon includes a binary upload step.
   */
  multipart?: boolean;
  /**
   * When true, sessions allocated for this plugin's browser fallback opt
   * into Browserbase's Scale Plan stealth profile (Windows desktop fingerprint
   * + solveCaptchas). DataDome-protected flows need this to clear the
   * silent fingerprint wall. Defaults to
   * false to avoid the cost penalty on plugins that don't need it.
   */
  advancedStealth?: boolean;
  /**
   * Extra Browserbase session-create params for this plugin's browser fallback;
   * `timeout` (seconds until the session auto-ends) is the intended knob. Core
   * applies `proxies` and `browserSettings.fingerprint` after these, and drops
   * `projectId` outright, so those stay Barnacle's. Nothing constrains the shape
   * beyond that.
   */
  browserbaseSessionCreateParams?: BrowserbaseSessionCreateParams;
  /**
   * Optional semver range string declaring which plugin API version this plugin
   * targets (e.g. `"^1.0.0"`). Core compares this against `PLUGIN_API_VERSION`
   * at load time and disables the plugin on a major-version mismatch. Absent
   * means "accept any version."
   */
  apiVersion?: string;
  /**
   * Extra non-run routes this plugin owns (e.g. OTP trigger, resume). Core
   * registers each at startup as an authenticated Fastify route, building the
   * same `SitePluginContext` as for `/run`. Error rendering is always delegated
   * to the app-level error handler; `envelope` on each route governs only the
   * success reply.
   */
  extraRoutes?: readonly SitePluginExtraRoute[];
  /**
   * Optional cleanup for background work the plugin launched fire-and-forget.
   * Awaited during graceful shutdown so in-flight work is not abandoned and
   * sessions are not leaked. Mirrors the engine's own drain functions.
   */
  onShutdown?: () => Promise<void>;
}

/**
 * Runtime dependencies injected by core immediately before `execute()` is called.
 * Plugins receive this instead of importing config or loggers directly, which
 * keeps each plugin self-contained and testable without the full app wired up.
 */
export interface SitePluginContext {
  /**
   * Resolved from `config.scraper.siteBaseUrls[meta.siteId]` by core. Plugins
   * should use this rather than reading config directly to stay decoupled from
   * the config shape.
   */
  baseUrl: string;
  /**
   * Request-scoped logger with `siteId` and `requestId` already bound by core.
   * Plugins log here without needing to create or configure their own logger.
   */
  logger: Logger;
  /**
   * Full application config. Prefer `baseUrl` for site URL resolution; reach
   * into `config` only for cross-cutting settings (timeouts, feature flags, etc.)
   * that core does not already surface through the context.
   */
  config: AppConfig;
  /**
   * Fastify-issued correlation ID for this inbound request. Core threads it
   * into the submission-envelope telemetry record so downstream tooling can
   * tie a captured outcome back to the originating API call.
   */
  requestId: string;
  /**
   * Step-timing accumulator for the current dispatch. Plugins call
   * `metricsCollector.startStep()` / `endStep()` at phase boundaries;
   * core finalizes and attaches the result to the response envelope.
   */
  metricsCollector: MetricsCollector;
}

/**
 * Value returned by `execute()` and consumed by core's dispatch layer. Core
 * merges `data` into the response envelope and emits a `submission-envelope`
 * telemetry record carrying `auditPayload` so audit and replay work without
 * re-running the browser flow.
 */
export interface SitePluginResult<TData = Record<string, unknown>> {
  /** Merged verbatim into the response envelope by core. */
  data: TData;
  /**
   * Written to the `submission-envelope` telemetry record by core. If absent, core
   * writes `data` instead. Intentionally not generic so plugins can redact PII
   * freely — only `Record<string, unknown>` is required, not a shape that
   * matches `TData`.
   */
  auditPayload?: Record<string, unknown>;
  /**
   * Step-level dispatch metrics attached by core after finalize(). Included in
   * the response envelope so the caller can forward into Segment events for
   * A/B warehouse analysis.
   */
  metrics?: DispatchMetrics;
}

/**
 * Contract every site plugin must satisfy. Core's dispatch layer types its
 * `SITE_PLUGINS` registry and `dispatch()` function against this interface so
 * adding a new site never requires changes to core — only a new file in
 * `src/sites/<id>/`.
 */
export interface SitePlugin<TPayload = unknown, TResult = Record<string, unknown>> {
  /** Static metadata used by the loader to register this plugin's Fastify route. */
  meta: SitePluginMeta;
  /**
   * Optional direct-HTTP hot path. When present, dispatch() tries this first.
   * On `HttpSchemaError`, `HttpBotChallengeError`, or `HttpServerError` it falls
   * through to `execute()` automatically — the plugin never has to wire the
   * fallback itself.
   *
   * Use `createHttpClient()` from `src/scraper/http-client.ts` to get a typed
   * fetch wrapper pre-wired with Bottleneck rate-limiting and Zod boundary
   * parsing. No browser, no LLM tokens — millisecond latency when it works.
   */
  executeHttp?: (
    payload: TPayload,
    context: SitePluginContext
  ) => Promise<SitePluginResult<TResult>>;
  /**
   * Performs the full browser-automation flow for one submission. Core acquires
   * `session` from the pool and injects `context` before calling this; the plugin
   * must not create or close sessions itself.
   *
   * Invoked automatically when `executeHttp` is absent or when it throws
   * `HttpSchemaError`, `HttpBotChallengeError`, or `HttpServerError`.
   */
  execute(
    payload: TPayload,
    session: BrowserSession,
    context: SitePluginContext
  ): Promise<SitePluginResult<TResult>>;
  /**
   * Optional hook called by core's retry layer before each retry attempt. Plugins
   * use this for telemetry or local cleanup (e.g. resetting in-memory state).
   * Async work is supported. Note: this hook is NOT called on `CaptchaError` or
   * `EmptyResultsError` — p-retry skips `onFailedAttempt` for AbortError, so
   * those abort paths bypass this hook entirely.
   */
  onRetry?: (error: ScraperError, attempt: number) => void | Promise<void>;
}
