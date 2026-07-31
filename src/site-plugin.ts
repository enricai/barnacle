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
import type { ScraperError } from "@/scraper/errors";
import type { BrowserSession } from "@/scraper/session";
import type { Logger } from "@/types/logging";

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
   * When true, the loader registers the route to accept `multipart/form-data`
   * via `@fastify/multipart` in `attachFieldsToBody: 'keyValues'` mode. Text
   * parts arrive as strings on `request.body`; file parts arrive as `Buffer`s.
   * Generator emits this for flows whose recon includes a binary upload step.
   */
  multipart?: boolean;
  /**
   * When true, sessions allocated for this plugin's browser fallback opt
   * into Browserbase's Scale Plan stealth profile (Windows desktop fingerprint
   * + solveCaptchas). DataDome-protected flows (notably apply.appcast.io
   * postings) need this to clear the silent fingerprint wall. Defaults to
   * false to avoid the cost penalty on plugins that don't need it.
   */
  advancedStealth?: boolean;
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
