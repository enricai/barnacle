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
import type { Action, ActOptions, ActResult, ExtractOptions, ObserveOptions, Stagehand } from "@browserbasehq/stagehand";
import { z } from "zod/v4";
import { type LlmCallInput } from "../lib/telemetry/call-capture";
/**
 * Injectable capture function — matches `captureLlmCall`'s signature. Same
 * shape as `JudgeCaptureFn` in `@/lib/llm/judge`. Lets each guard call route
 * its telemetry into the caller's per-run NDJSON sink instead of the global
 * default in `captureLlmCall`. Without this, every Stagehand guard entry
 * lands in `.barnacle/calls.ndjson` instead of the per-URL run partition.
 */
export type StagehandCaptureFn = (input: LlmCallInput) => Promise<void>;
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
export declare const ACTION_SCHEMA: z.ZodObject<{
    selector: z.ZodString;
    description: z.ZodString;
    method: z.ZodOptional<z.ZodString>;
    arguments: z.ZodOptional<z.ZodArray<z.ZodString>>;
}, z.core.$strip>;
/**
 * Zod mirror of Stagehand's public `ActResult` shape. The `actions` array
 * is sometimes empty when Stagehand acted via a path that doesn't echo the
 * action back; the cascade's resolvedAction fallback already handles that
 * case. We accept empty arrays here as valid per the SDK contract.
 */
export declare const ACT_RESULT_SCHEMA: z.ZodObject<{
    success: z.ZodBoolean;
    message: z.ZodString;
    actionDescription: z.ZodString;
    actions: z.ZodArray<z.ZodObject<{
        selector: z.ZodString;
        description: z.ZodString;
        method: z.ZodOptional<z.ZodString>;
        arguments: z.ZodOptional<z.ZodArray<z.ZodString>>;
    }, z.core.$strip>>;
    cacheStatus: z.ZodOptional<z.ZodEnum<{
        HIT: "HIT";
        MISS: "MISS";
    }>>;
}, z.core.$strip>;
/**
 * Thrown by any guarded* wrapper when Stagehand's return value doesn't
 * `safeParse` against the schema. The `kind` is always
 * `"schema-validation-failed"` — same string the Anthropic SDK callers use
 * — so `classifyLlmCallFailure` routes it to the same NDJSON failureKind
 * bucket without any string-matching changes.
 */
export declare class StagehandSchemaError extends Error {
    readonly kind: "schema-validation-failed";
    readonly primitive: "act" | "observe" | "extract";
    readonly zodError: z.ZodError;
    readonly rawResponse: unknown;
    constructor(primitive: "act" | "observe" | "extract", zodError: z.ZodError, rawResponse: unknown);
}
/**
 * Schema-guarded wrapper around Stagehand's `act`. Same signature as the
 * underlying call: accepts either an instruction string or a structured
 * `Action` (from a prior `observe`). On the happy path, returns Stagehand's
 * `ActResult` verbatim. On envelope drift, throws `StagehandSchemaError`
 * and logs `failureKind: "schema-validation-failed"`.
 */
export declare function guardedAct(stagehand: Stagehand, input: string | Action, options?: ActOptions, captureFn?: StagehandCaptureFn): Promise<ActResult>;
/**
 * Schema-guarded wrapper around Stagehand's `observe`. Mirrors the
 * Stagehand overloads: no args, options-only, instruction-only,
 * instruction + options. On envelope drift (the `Action[]` shape changes),
 * throws `StagehandSchemaError`.
 */
export declare function guardedObserve(stagehand: Stagehand, instruction?: string, options?: ObserveOptions, captureFn?: StagehandCaptureFn): Promise<Action[]>;
/**
 * Schema-guarded wrapper around Stagehand's `extract` 3-arg overload. The
 * caller's Zod schema is what Stagehand asks the LLM to satisfy AND what we
 * `safeParse` against caller-side. Refuse the 1-arg / 2-arg defaults; every
 * extract call in the codebase must enforce a schema.
 */
export declare function guardedExtract<T extends z.ZodTypeAny>(stagehand: Stagehand, instruction: string, schema: T, options?: ExtractOptions, captureFn?: StagehandCaptureFn): Promise<z.infer<T>>;
