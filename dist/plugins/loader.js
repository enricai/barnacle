"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.SITE_PLUGINS = void 0;
exports.dispatch = dispatch;
exports.registerRoutes = registerRoutes;
const multipart_1 = __importDefault(require("@fastify/multipart"));
const errors_1 = require("../api/errors");
const envelope_1 = require("../api/helpers/envelope");
const response_cache_1 = require("../cache/response-cache");
const client_1 = require("../lib/db/client");
const errors_2 = require("../lib/errors");
const logging_1 = require("../lib/logging");
const errors_3 = require("../scraper/errors");
const metrics_1 = require("../scraper/metrics");
const pool_1 = require("../scraper/pool");
const logger = (0, logging_1.getLogger)({ name: "plugins/loader" });
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
exports.SITE_PLUGINS = [];
/**
 * Pure mapping from scraper-internal errors to the public ApiError hierarchy.
 *
 * Exists so dispatch()'s catch block stays a short tail of guard clauses —
 * the if-instanceof chain captures the entire scraper-to-wire error contract
 * in one place. Returns `undefined` when the caller should re-throw the
 * original error (plain Error or anything outside the ScraperError tree).
 */
function toApiError(err) {
    if (err instanceof errors_3.CaptchaError)
        return new errors_1.CaptchaEncounteredError(err.message);
    if (err instanceof errors_3.EmptyResultsError)
        return new errors_1.EmptyResultsApiError(err.message);
    if (err instanceof errors_3.HttpRateLimitError)
        return new errors_1.ThrottledRequestError(err.message);
    if (err instanceof errors_3.ScraperError)
        return new errors_1.ScrapeFailureError(err.message);
    return undefined;
}
/**
 * Writes a single audit row to the SiteSubmission table.
 *
 * Exists because dispatch() persists audit rows on both the success and the
 * failure branches and the inline `prisma.siteSubmission.create({ ... })`
 * + try/catch + log block was duplicated. Centralising it keeps the
 * audit-write semantics (best-effort, never re-throws, always logs a warning
 * on DB failure) consistent across both branches.
 */
async function recordSubmission(siteId, status, payload) {
    try {
        await client_1.prisma.siteSubmission.create({
            data: { siteId, status, payload },
        });
    }
    catch (dbErr) {
        const phase = status === "submitted" ? "successful scrape" : "scrape error";
        logger.warn(`audit write failed after ${phase}: ${(0, errors_2.toErrorMessage)(dbErr)}`);
    }
}
/**
 * Runs the hot path (when available) + fallback pipeline for a single
 * submission. Extracted so dispatch() reads as a linear "run pipeline,
 * record audit, return" sequence rather than a `let result` mutated across
 * three branches.
 */
async function runPluginPipeline(plugin, payload, context, options) {
    if (!plugin.executeHttp || options.forceFallback) {
        if (options.forceFallback) {
            (0, metrics_1.recordFallbackActivation)(plugin.meta.siteId);
        }
        return (await (0, pool_1.runWithSession)((session) => plugin.execute(payload, session, context), { onRetry: plugin.onRetry }, plugin.meta.taskTimeoutMs, { advancedStealth: plugin.meta.advancedStealth }));
    }
    try {
        const { value: cached, key } = (0, response_cache_1.getCachedResponse)(`${context.baseUrl}:${plugin.meta.siteId}`, payload);
        if (cached) {
            (0, metrics_1.recordHotPathSuccess)(plugin.meta.siteId);
            return cached;
        }
        const t0 = Date.now();
        const fresh = await (0, response_cache_1.getOrCreateInFlight)(key, 
        // biome-ignore lint/style/noNonNullAssertion: guarded by !plugin.executeHttp above
        () => plugin.executeHttp(payload, context));
        (0, metrics_1.recordHotPathLatency)(plugin.meta.siteId, Date.now() - t0);
        (0, metrics_1.recordHotPathSuccess)(plugin.meta.siteId);
        return fresh;
    }
    catch (httpErr) {
        if (httpErr instanceof errors_3.HttpSchemaError ||
            httpErr instanceof errors_3.HttpBotChallengeError ||
            httpErr instanceof errors_3.HttpServerError) {
            logger.warn(`hot path failed for ${plugin.meta.siteId} (${httpErr.constructor.name}): ${httpErr.message} — engaging browser fallback`);
            (0, metrics_1.recordFallbackActivation)(plugin.meta.siteId);
            return (await (0, pool_1.runWithSession)((session) => plugin.execute(payload, session, context), { onRetry: plugin.onRetry }, plugin.meta.taskTimeoutMs, { advancedStealth: plugin.meta.advancedStealth }));
        }
        if (httpErr instanceof errors_3.HttpRateLimitError) {
            logger.warn(`hot path rate-limited for ${plugin.meta.siteId}: ${httpErr.message} — not falling back`);
            (0, metrics_1.recordRateLimitRejection)(plugin.meta.siteId);
        }
        throw httpErr;
    }
}
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
async function dispatch(plugin, payload, context, options = {}) {
    try {
        const result = await runPluginPipeline(plugin, payload, context, options);
        await recordSubmission(plugin.meta.siteId, "submitted", (result.auditPayload ?? result.data));
        return result;
    }
    catch (err) {
        await recordSubmission(plugin.meta.siteId, "error", {
            error: (0, errors_2.toErrorMessage)(err),
            siteId: plugin.meta.siteId,
        });
        const apiErr = toApiError(err);
        if (apiErr)
            throw apiErr;
        throw err;
    }
}
/**
 * Registers one Fastify POST route per plugin in `SITE_PLUGINS`. Called
 * from `buildServer()` so `server.ts` stays site-agnostic — it delegates
 * all plugin-specific route knowledge (path, schema, dispatch) to this
 * module instead of maintaining an inline loop.
 */
async function registerRoutes(app, cfg) {
    if (exports.SITE_PLUGINS.some((p) => p.meta.multipart === true)) {
        await app.register(multipart_1.default, { attachFieldsToBody: "keyValues" });
    }
    for (const plugin of exports.SITE_PLUGINS) {
        const routePath = plugin.meta.routeOverride ?? `/v1/${plugin.meta.siteId}/run`;
        const baseUrl = cfg.scraper.siteBaseUrls[plugin.meta.siteId] ?? plugin.meta.defaultBaseUrl ?? "";
        app.post(routePath, {
            onRequest: [app.authenticate],
            schema: {
                body: plugin.meta.bodySchema,
                response: { 200: plugin.meta.responseSchema },
                ...(plugin.meta.multipart === true ? { consumes: ["multipart/form-data"] } : {}),
            },
        }, async (request) => {
            const forceFallback = request.headers["x-barnacle-force-fallback"] === "true";
            const context = {
                baseUrl,
                logger: (0, logging_1.extendLogger)(request.log),
                config: cfg,
            };
            const result = await dispatch(plugin, request.body, context, { forceFallback });
            return (0, envelope_1.successEnvelope)(result.data);
        });
    }
    logger.info(`registered ${exports.SITE_PLUGINS.length} site plugin routes`);
}
//# sourceMappingURL=loader.js.map