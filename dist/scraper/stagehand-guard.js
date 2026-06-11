"use strict";
/**
 * Schema-enforcing wrappers around Stagehand's `act`, `observe`, and
 * `extract`. Every Stagehand SDK call in the codebase routes through these
 * so the engine has a single chokepoint for return-envelope validation +
 * telemetry capture.
 *
 * Two enforcement modes by primitive:
 *
 *  - `act` and `observe`: Stagehand owns the underlying LLM call and does
 *    not expose a caller-provided schema field on `ActOptions` /
 *    `ObserveOptions`. The strictest enforcement Stagehand's API allows is
 *    caller-side `safeParse` of the RETURN ENVELOPE against Zod mirrors of
 *    Stagehand's public types (`ActResult`, `Action`). On envelope drift
 *    (a Stagehand SDK upgrade that widens the shape, or a Stagehand bug
 *    that emits malformed JSON), the wrapper throws
 *    `StagehandSchemaError` and records a `failureKind:
 *    "schema-validation-failed"` entry to the NDJSON sink, matching the
 *    failure taxonomy of our direct Anthropic SDK callers.
 *
 *  - `extract`: Stagehand's 3-arg overload accepts a caller-provided Zod
 *    schema and routes structured output through the LLM the same way our
 *    `messages.parse + zodOutputFormat` calls do. Stagehand `safeParse`s
 *    server-side; we `safeParse` again caller-side as defense in depth
 *    against SDK contract drift (and to log identical telemetry).
 *
 * Telemetry: every wrapper call lands in `calls.ndjson` regardless of
 * outcome (per user directive — full parity with our Anthropic SDK call
 * telemetry). Volume is dominated by `act`: hundreds of calls per job
 * across the cascade attempts ≈ thousands of entries per sweep. The
 * NDJSON sink is append-only and per-URL partitioned (see
 * `src/lib/telemetry/telemetry-paths.ts`) so this scale is intentional.
 *
 * Stagehand Zod compat: as of `@browserbasehq/stagehand@3.4.0`,
 * `StagehandZodSchema = Zod4TypeAny | z3.ZodTypeAny` — both Zod v3 and v4
 * schemas pass through cleanly (confirmed in
 * `node_modules/@browserbasehq/stagehand/dist/esm/lib/v3/zodCompat.d.ts`).
 * Barnacle uses Zod v4 via the `zod/v4` subpath export; that's compatible.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.StagehandSchemaError = exports.ACT_RESULT_SCHEMA = exports.ACTION_SCHEMA = void 0;
exports.guardedAct = guardedAct;
exports.guardedObserve = guardedObserve;
exports.guardedExtract = guardedExtract;
const node_crypto_1 = require("node:crypto");
const v4_1 = require("zod/v4");
const call_capture_1 = require("../lib/telemetry/call-capture");
const call_types_1 = require("../lib/telemetry/call-types");
/**
 * Zod mirror of Stagehand's public `Action` shape (from
 * `@browserbasehq/stagehand/.../public/methods.d.ts`):
 *
 *   interface Action {
 *     selector: string;
 *     description: string;
 *     method?: string;
 *     arguments?: string[];
 *   }
 *
 * If Stagehand widens this shape in a future minor version, our `safeParse`
 * fails closed — we'd rather see a `schema-validation-failed` entry in
 * telemetry than have downstream code silently consume drift.
 */
exports.ACTION_SCHEMA = v4_1.z.object({
    selector: v4_1.z.string(),
    description: v4_1.z.string(),
    method: v4_1.z.string().optional(),
    arguments: v4_1.z.array(v4_1.z.string()).optional(),
});
/**
 * Zod mirror of Stagehand's public `ActResult` shape. The `actions` array
 * is sometimes empty when Stagehand acted via a path that doesn't echo the
 * action back; the cascade's resolvedAction fallback already handles that
 * case. We accept empty arrays here as valid per the SDK contract.
 */
exports.ACT_RESULT_SCHEMA = v4_1.z.object({
    success: v4_1.z.boolean(),
    message: v4_1.z.string(),
    actionDescription: v4_1.z.string(),
    actions: v4_1.z.array(exports.ACTION_SCHEMA),
    cacheStatus: v4_1.z.enum(["HIT", "MISS"]).optional(),
});
/**
 * Thrown by any guarded* wrapper when Stagehand's return value doesn't
 * `safeParse` against the schema. The `kind` is always
 * `"schema-validation-failed"` — same string the Anthropic SDK callers use
 * — so `classifyLlmCallFailure` routes it to the same NDJSON failureKind
 * bucket without any string-matching changes.
 */
class StagehandSchemaError extends Error {
    kind = "schema-validation-failed";
    primitive;
    zodError;
    rawResponse;
    constructor(primitive, zodError, rawResponse) {
        super(`stagehand ${primitive} envelope failed schema validation: ${zodError.message}`);
        this.name = "StagehandSchemaError";
        this.primitive = primitive;
        this.zodError = zodError;
        this.rawResponse = rawResponse;
    }
}
exports.StagehandSchemaError = StagehandSchemaError;
/**
 * Stringify a possibly-circular value safely; used to populate
 * `responseContent` in telemetry without risking a `TypeError` on circular
 * Stagehand internals.
 */
function safeStringify(value, cap = 4000) {
    try {
        return JSON.stringify(value).slice(0, cap);
    }
    catch {
        return String(value).slice(0, cap);
    }
}
/** Pluck the bare instruction string from either form of `act` input. */
function actInstructionOf(input) {
    return typeof input === "string" ? input : input.description;
}
/**
 * Schema-guarded wrapper around Stagehand's `act`. Same signature as the
 * underlying call: accepts either an instruction string or a structured
 * `Action` (from a prior `observe`). On the happy path, returns Stagehand's
 * `ActResult` verbatim. On envelope drift, throws `StagehandSchemaError`
 * and logs `failureKind: "schema-validation-failed"`.
 */
async function guardedAct(stagehand, input, options, captureFn) {
    const callId = (0, node_crypto_1.randomUUID)();
    const userContent = actInstructionOf(input);
    const t0 = performance.now();
    try {
        // Stagehand's `act` has two overloads (string and Action) that share the
        // same runtime implementation (dispatch is via `isObserveResult` inside
        // Stagehand). The two branches LOOK identical but TS can't resolve the
        // union against the overload set without splitting them — and assigning
        // `stagehand.act` to a variable then calling it as a standalone function
        // loses `this` in strict mode, which crashes inside Stagehand's
        // `withInstanceLogContext(this.instanceId, ...)` wrapper on entry.
        const raw = typeof input === "string"
            ? await stagehand.act(input, options)
            : await stagehand.act(input, options);
        const latencyMs = performance.now() - t0;
        const parsed = exports.ACT_RESULT_SCHEMA.safeParse(raw);
        if (!parsed.success) {
            await captureCall({
                callId,
                callType: call_types_1.CALL_TYPE_STAGEHAND_ACT,
                userContent,
                responseContent: safeStringify(raw),
                latencyMs,
                success: false,
                parsedOk: false,
                errorMessage: `act envelope failed schema validation: ${parsed.error.message}`,
                failureKind: "schema-validation-failed",
            }, captureFn);
            throw new StagehandSchemaError("act", parsed.error, raw);
        }
        await captureCall({
            callId,
            callType: call_types_1.CALL_TYPE_STAGEHAND_ACT,
            userContent,
            responseContent: safeStringify(parsed.data),
            latencyMs,
            success: parsed.data.success,
            parsedOk: true,
            errorMessage: null,
            failureKind: null,
        }, captureFn);
        return parsed.data;
    }
    catch (err) {
        if (err instanceof StagehandSchemaError)
            throw err;
        const latencyMs = performance.now() - t0;
        await captureCall({
            callId,
            callType: call_types_1.CALL_TYPE_STAGEHAND_ACT,
            userContent,
            responseContent: null,
            latencyMs,
            success: false,
            parsedOk: false,
            errorMessage: err instanceof Error ? err.message : String(err),
            failureKind: (0, call_capture_1.classifyLlmCallFailure)(err),
        }, captureFn);
        throw err;
    }
}
/**
 * Schema-guarded wrapper around Stagehand's `observe`. Mirrors the
 * Stagehand overloads: no args, options-only, instruction-only,
 * instruction + options. On envelope drift (the `Action[]` shape changes),
 * throws `StagehandSchemaError`.
 */
async function guardedObserve(stagehand, instruction, options, captureFn) {
    const callId = (0, node_crypto_1.randomUUID)();
    const userContent = instruction ?? "";
    const t0 = performance.now();
    try {
        // Match Stagehand's overloads: pass instruction only when defined, so
        // the SDK falls through to its no-arg/options-only path otherwise.
        const raw = instruction === undefined
            ? options === undefined
                ? await stagehand.observe()
                : await stagehand.observe(options)
            : await stagehand.observe(instruction, options);
        const latencyMs = performance.now() - t0;
        const parsed = v4_1.z.array(exports.ACTION_SCHEMA).safeParse(raw);
        if (!parsed.success) {
            await captureCall({
                callId,
                callType: call_types_1.CALL_TYPE_STAGEHAND_OBSERVE,
                userContent,
                responseContent: safeStringify(raw),
                latencyMs,
                success: false,
                parsedOk: false,
                errorMessage: `observe envelope failed schema validation: ${parsed.error.message}`,
                failureKind: "schema-validation-failed",
            }, captureFn);
            throw new StagehandSchemaError("observe", parsed.error, raw);
        }
        await captureCall({
            callId,
            callType: call_types_1.CALL_TYPE_STAGEHAND_OBSERVE,
            userContent,
            responseContent: safeStringify(parsed.data),
            latencyMs,
            success: true,
            parsedOk: true,
            errorMessage: null,
            failureKind: null,
        }, captureFn);
        return parsed.data;
    }
    catch (err) {
        if (err instanceof StagehandSchemaError)
            throw err;
        const latencyMs = performance.now() - t0;
        await captureCall({
            callId,
            callType: call_types_1.CALL_TYPE_STAGEHAND_OBSERVE,
            userContent,
            responseContent: null,
            latencyMs,
            success: false,
            parsedOk: false,
            errorMessage: err instanceof Error ? err.message : String(err),
            failureKind: (0, call_capture_1.classifyLlmCallFailure)(err),
        }, captureFn);
        throw err;
    }
}
/**
 * Schema-guarded wrapper around Stagehand's `extract` 3-arg overload. The
 * caller's Zod schema is what Stagehand asks the LLM to satisfy AND what we
 * `safeParse` against caller-side. Refuse the 1-arg / 2-arg defaults; every
 * extract call in the codebase must enforce a schema.
 */
async function guardedExtract(stagehand, instruction, schema, options, captureFn) {
    const callId = (0, node_crypto_1.randomUUID)();
    const t0 = performance.now();
    try {
        // Widening cast: caller's `z.ZodTypeAny` (Zod v4) is one branch of
        // Stagehand's `StagehandZodSchema = Zod4TypeAny | z3.ZodTypeAny` union,
        // which Stagehand's extract overload-2 expects. We can't reference
        // `StagehandZodSchema` directly because it's a deep import not exported
        // from the package root; `Parameters<typeof stagehand.extract>[1]` is
        // the cleanest public-API way to express "whatever overload-2 expects."
        // The `as unknown` step is needed because TS won't accept a single
        // direct cast across the entire overload set.
        const raw = await stagehand.extract(instruction, schema, options);
        const latencyMs = performance.now() - t0;
        const parsed = schema.safeParse(raw);
        if (!parsed.success) {
            await captureCall({
                callId,
                callType: call_types_1.CALL_TYPE_STAGEHAND_EXTRACT,
                userContent: instruction,
                responseContent: safeStringify(raw),
                latencyMs,
                success: false,
                parsedOk: false,
                errorMessage: `extract envelope failed schema validation: ${parsed.error.message}`,
                failureKind: "schema-validation-failed",
            }, captureFn);
            throw new StagehandSchemaError("extract", parsed.error, raw);
        }
        await captureCall({
            callId,
            callType: call_types_1.CALL_TYPE_STAGEHAND_EXTRACT,
            userContent: instruction,
            responseContent: safeStringify(parsed.data),
            latencyMs,
            success: true,
            parsedOk: true,
            errorMessage: null,
            failureKind: null,
        }, captureFn);
        return parsed.data;
    }
    catch (err) {
        if (err instanceof StagehandSchemaError)
            throw err;
        const latencyMs = performance.now() - t0;
        await captureCall({
            callId,
            callType: call_types_1.CALL_TYPE_STAGEHAND_EXTRACT,
            userContent: instruction,
            responseContent: null,
            latencyMs,
            success: false,
            parsedOk: false,
            errorMessage: err instanceof Error ? err.message : String(err),
            failureKind: (0, call_capture_1.classifyLlmCallFailure)(err),
        }, captureFn);
        throw err;
    }
}
/**
 * Internal helper: fills the constant `model` / `systemPrompt` /
 * `inputTokens` / `outputTokens` fields Stagehand doesn't expose. The
 * underlying LLM call inside `act`/`observe` uses Stagehand-owned tokens
 * we don't have visibility into; we record `null` per the existing
 * `LlmCallInput` contract (which already supports null for those fields).
 */
async function captureCall(partial, captureFn = call_capture_1.captureLlmCall) {
    await captureFn({
        ...partial,
        model: "stagehand-internal",
        systemPrompt: null,
        inputTokens: null,
        outputTokens: null,
    });
}
//# sourceMappingURL=stagehand-guard.js.map