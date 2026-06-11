"use strict";
/**
 * Append-only NDJSON sink for LLM/Stagehand call samples. Each call emits
 * exactly one line so the judge and self-heal skills have a scoreable corpus
 * without coupling this module to any specific call site.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.llmCallSampleSchema = exports.ANTHROPIC_QUOTA_MESSAGE_RX = exports.llmCallFailureKindSchema = void 0;
exports.classifyLlmCallFailure = classifyLlmCallFailure;
exports.captureLlmCall = captureLlmCall;
const promises_1 = require("node:fs/promises");
const node_path_1 = require("node:path");
const date_fns_1 = require("date-fns");
const v4_1 = require("zod/v4");
const config_1 = require("../../config");
const logging_1 = require("../../lib/logging");
const logger = (0, logging_1.getLogger)({ name: "telemetry/call-capture" });
/**
 * Categorical failure reason for an LLM call. Surfaces post-mortem without
 * regex-scanning `errorMessage`. Discriminated upstream by the caller.
 */
exports.llmCallFailureKindSchema = v4_1.z.enum([
    "anthropic-billing",
    "anthropic-rate-limit",
    "anthropic-other",
    "schema-validation-failed",
    "response-empty",
    "exception-other",
]);
/**
 * Anthropic returns status 400 + `error.type === "invalid_request_error"`
 * for BOTH genuine bad-request errors AND quota/spend-limit exhaustion.
 * The official taxonomy at https://platform.claude.com/docs/en/api/errors
 * reuses the same enum value for format problems and quota hits; only the
 * embedded `error.message` text discriminates the latter. This regex is
 * confined to that single ambiguous status+type branch in
 * classifyLlmCallFailure — it is not a broad message scan.
 */
exports.ANTHROPIC_QUOTA_MESSAGE_RX = /(your credit balance is too low|insufficient_quota|billing_hard_limit_reached|reached your specified API usage limits|usage limits)/i;
/**
 * Extract the HTTP status from any of: direct `.status`, `.statusCode`,
 * or the `"<NNN> {json}"` prefix the Vercel ai SDK uses for its default
 * error message format. Returns undefined when no status signal exists.
 */
function extractAnthropicStatus(errorObj, message) {
    if (errorObj !== null) {
        if (typeof errorObj.status === "number")
            return errorObj.status;
        if (typeof errorObj.statusCode === "number")
            return errorObj.statusCode;
    }
    const match = message.match(/(?:^|\s)(\d{3})\s+\{/);
    if (match?.[1]) {
        const parsed = Number.parseInt(match[1], 10);
        if (parsed >= 100 && parsed < 600)
            return parsed;
    }
    return undefined;
}
/**
 * Extract Anthropic's structured `error.type` from whichever shape the SDK
 * chain exposed: direct `.type` (Anthropic SDK APIError), `.responseBody`
 * JSON (Vercel ai SDK APICallError), `.data` (Vercel ai SDK), or the JSON
 * body embedded in `err.message` as `"<status> {json}"` (the Vercel ai
 * SDK's default toString format). Returns null when no structured marker
 * is present.
 */
function extractAnthropicErrorType(errorObj) {
    if (errorObj === null)
        return null;
    if (typeof errorObj.type === "string")
        return errorObj.type;
    const responseBody = errorObj.responseBody;
    if (typeof responseBody === "string" && responseBody.length > 0) {
        try {
            const parsed = JSON.parse(responseBody);
            const t = parsed.error?.type ?? parsed.type;
            if (typeof t === "string")
                return t;
        }
        catch {
            // fall through
        }
    }
    const data = errorObj.data;
    if (data !== undefined && data !== null) {
        const t = data.error?.type ?? data.type;
        if (typeof t === "string")
            return t;
    }
    const message = typeof errorObj.message === "string" ? errorObj.message : "";
    const jsonMatch = message.match(/\d{3}\s+(\{.+\})$/s);
    if (jsonMatch?.[1]) {
        try {
            const parsed = JSON.parse(jsonMatch[1]);
            const t = parsed.error?.type ?? parsed.type;
            if (typeof t === "string")
                return t;
        }
        catch {
            // fall through
        }
    }
    return null;
}
/**
 * Classify a thrown LLM-call error into one of the discrete failure kinds.
 *
 * Strategy (priority-ordered):
 *   1. Status + structured `error.type` from the SDK fields. Anthropic's
 *      documented taxonomy: 402 + billing_error = payment; 429 +
 *      rate_limit_error = rate-limited.
 *   2. For the (400 + invalid_request_error) tuple, Anthropic provides no
 *      structural discriminator between "bad format" and "quota exhausted"
 *      — match the embedded error.message against ANTHROPIC_QUOTA_MESSAGE_RX
 *      to identify the latter. This is the one documented exception to
 *      structural classification.
 *   3. Best-effort fallbacks for errors whose SDK shape stripped structure
 *      (legacy paths, generic exceptions).
 *
 * SDK-agnostic via duck-typing — works with @anthropic-ai/sdk's APIError,
 * Vercel ai SDK's APICallError, or any provider exposing similar fields.
 */
function classifyLlmCallFailure(err) {
    const errorObj = typeof err === "object" && err !== null ? err : null;
    const message = err instanceof Error ? err.message : String(err);
    const name = err instanceof Error ? err.name : "";
    const structuredType = extractAnthropicErrorType(errorObj);
    const status = extractAnthropicStatus(errorObj, message);
    if (structuredType === "billing_error" || status === 402)
        return "anthropic-billing";
    if (structuredType === "rate_limit_error" || status === 429 || name === "RateLimitError") {
        return "anthropic-rate-limit";
    }
    if (status === 400 && structuredType === "invalid_request_error") {
        if (exports.ANTHROPIC_QUOTA_MESSAGE_RX.test(message))
            return "anthropic-billing";
        return "anthropic-other";
    }
    if (structuredType !== null)
        return "anthropic-other";
    if (typeof status === "number" && status >= 400 && status < 600)
        return "anthropic-other";
    if (exports.ANTHROPIC_QUOTA_MESSAGE_RX.test(message))
        return "anthropic-billing";
    if (/APIError$|AnthropicError$|APICallError$/.test(name))
        return "anthropic-other";
    if (/zod|schema|parsed_output is null/i.test(message))
        return "schema-validation-failed";
    return "exception-other";
}
/**
 * Validated shape of one LLM call sample. Field names follow beacon/pila's
 * NDJSON contract but in Barnacle's camelCase convention.
 */
exports.llmCallSampleSchema = v4_1.z.object({
    callId: v4_1.z.string(),
    callType: v4_1.z.string(),
    model: v4_1.z.string(),
    systemPrompt: v4_1.z.string().nullable(),
    userContent: v4_1.z.string(),
    responseContent: v4_1.z.string().nullable(),
    parsedOk: v4_1.z.boolean(),
    inputTokens: v4_1.z.number().int().nullable(),
    outputTokens: v4_1.z.number().int().nullable(),
    latencyMs: v4_1.z.number().nullable(),
    success: v4_1.z.boolean(),
    errorMessage: v4_1.z.string().nullable(),
    failureKind: exports.llmCallFailureKindSchema.nullable(),
    ts: v4_1.z.string(),
});
/**
 * Appends one validated NDJSON line for an LLM call to the configured sink.
 * Errors are logged and swallowed — telemetry must never break the happy path.
 */
async function captureLlmCall(input, opts = {}) {
    const sinkPath = opts.sinkPath ?? config_1.config.telemetry.callsNdjsonPath;
    const sample = { ...input, ts: (0, date_fns_1.formatISO)(new Date()) };
    try {
        const line = `${JSON.stringify(sample)}\n`;
        await (0, promises_1.mkdir)((0, node_path_1.dirname)(sinkPath), { recursive: true });
        await (0, promises_1.appendFile)(sinkPath, line, "utf8");
    }
    catch (err) {
        logger.error(`captureLlmCall: failed to write to ${sinkPath}: ${String(err)}`);
    }
}
//# sourceMappingURL=call-capture.js.map