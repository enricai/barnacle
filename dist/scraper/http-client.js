"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.createHttpClient = createHttpClient;
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const p_retry_1 = __importStar(require("p-retry"));
const logging_1 = require("../lib/logging");
const errors_1 = require("../scraper/errors");
const logger = (0, logging_1.getLogger)({ name: "scraper/http-client" });
/**
 * One-shot diagnostic: when `CAPTURE_BASELINE_BODIES=1`, write each successful
 * (2xx) request to a numbered JSON file under the destination directory
 * (`BASELINE_BODIES_DIR`, default `/tmp/clearcompany-baseline-bodies`). Used to
 * snapshot the current hot-path request shapes as a frozen regression baseline
 * before refactors that would alter how the JSON bodies are built. Off in
 * production unless explicitly enabled.
 */
let baselineCallCounter = 0;
/**
 * Factory that creates a typed direct-HTTP request function pre-wired with
 * the plugin's Bottleneck limiter, p-retry for transient network failures,
 * and Zod response schema. This is the hot-path runtime: no browser, no LLM
 * tokens, millisecond latency.
 *
 * Hot-path chain per spec §5A:
 *   lru-cache (response cache, in dispatch layer)
 *   → fetch(endpoint) → bottleneck (rate limit) → p-retry (transient failures)
 *   → zod.parse(response) → return
 *
 * Throws `HttpSchemaError` when the response body doesn't match the schema —
 * dispatch() uses that as the trigger to fall back to the Stagehand path.
 * Throws `HttpBotChallengeError` on 401/403 — also a fallback trigger.
 * Throws `HttpServerError` on 5xx — also a fallback trigger; a server-side
 * outage is not the same as a bot block but the recovery is identical.
 * Throws `HttpRateLimitError` on 429 — NOT a fallback trigger; the caller
 * should back off, not burn a Steel session.
 * Wraps transient network errors in `UnknownScraperError` and retries up to
 * 2 times with exponential backoff before propagating.
 */
function createHttpClient(options) {
    const { schema, bottleneck, baseHeaders } = options;
    return async (url, init = {}) => {
        return bottleneck.schedule(() => (0, p_retry_1.default)(async () => {
            const method = init.method ?? "GET";
            const headers = { ...baseHeaders, ...(init.headers ?? {}) };
            let response;
            try {
                response = await fetch(url, {
                    method,
                    headers,
                    body: init.body,
                    signal: init.signal,
                });
            }
            catch (err) {
                // Caller-triggered cancellation — propagate without retry. The
                // outer p-retry's own `signal` option will also throwIfAborted
                // on its retry-loop boundaries, but wrapping in AbortError here
                // covers the window between fetch dispatch and the next signal
                // check inside pRetry.
                if (err instanceof Error && err.name === "AbortError") {
                    throw new p_retry_1.AbortError(err);
                }
                // Network-level failure (DNS, TCP reset, timeout) — retryable.
                throw new errors_1.UnknownScraperError(`http fetch failed: ${String(err)}`);
            }
            if (response.status === 401 || response.status === 403) {
                // Bot challenge / auth wall — not a transient failure, abort retry.
                throw new p_retry_1.AbortError(new errors_1.HttpBotChallengeError(`http ${response.status} from ${url} — bot challenge or auth required`));
            }
            if (response.status === 429) {
                // Rate limit — not a transient failure, abort retry.
                throw new p_retry_1.AbortError(new errors_1.HttpRateLimitError(`http 429 from ${url} — rate limit exceeded`));
            }
            if (response.status >= 500) {
                // Server error — non-retryable at the HTTP level; dispatch() will
                // engage the browser fallback instead.
                throw new p_retry_1.AbortError(new errors_1.HttpServerError(`http ${response.status} from ${url}`));
            }
            if (process.env.CAPTURE_BASELINE_BODIES === "1") {
                try {
                    const dir = process.env.BASELINE_BODIES_DIR ?? "/tmp/clearcompany-baseline-bodies";
                    (0, node_fs_1.mkdirSync)(dir, { recursive: true });
                    const idx = String(baselineCallCounter++).padStart(2, "0");
                    const slug = new URL(url).pathname
                        .split("/")
                        .filter(Boolean)
                        .slice(-2)
                        .join("-")
                        .replace(/[^a-zA-Z0-9._-]/g, "_") || "root";
                    const target = (0, node_path_1.join)(dir, `${idx}-${method}-${slug}.json`);
                    (0, node_fs_1.writeFileSync)(target, JSON.stringify({
                        method,
                        url,
                        status: response.status,
                        requestHeaders: headers,
                        requestBody: init.body ?? null,
                    }, null, 2));
                    logger.warn(`baseline-body captured: ${target}`);
                }
                catch (err) {
                    logger.warn(`baseline-body capture failed: ${err instanceof Error ? err.message : String(err)}`);
                }
            }
            let body;
            try {
                body = await response.json();
            }
            catch (err) {
                // Malformed JSON — not transient, abort retry.
                throw new p_retry_1.AbortError(new errors_1.HttpSchemaError(`response body is not valid JSON: ${String(err)}`));
            }
            const parsed = schema.safeParse(body);
            if (!parsed.success) {
                logger.warn(`http schema mismatch from ${url}: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
                // Schema mismatch — not transient, abort retry.
                throw new p_retry_1.AbortError(new errors_1.HttpSchemaError(`response schema mismatch: ${parsed.error.issues.map((i) => i.message).join("; ")}`));
            }
            return parsed.data;
        }, {
            retries: 2,
            factor: 2,
            minTimeout: 200,
            maxTimeout: 1_000,
            randomize: true,
            signal: init.signal,
            onFailedAttempt: (context) => {
                logger.warn(`http hot-path attempt ${context.attemptNumber} failed: ${context.error.message}; ${context.retriesLeft} retries left`);
            },
        }));
    };
}
//# sourceMappingURL=http-client.js.map