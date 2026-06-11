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
 * telemetry). Volume is dominated by `act`: ~131 calls × ~12 jobs × cascade
 * attempts ≈ several thousand entries per sweep. The NDJSON sink is
 * append-only and per-URL partitioned (see `src/lib/telemetry/telemetry-paths.ts`)
 * so this scale is intentional.
 *
 * Stagehand Zod compat: as of `@browserbasehq/stagehand@3.4.0`,
 * `StagehandZodSchema = Zod4TypeAny | z3.ZodTypeAny` — both Zod v3 and v4
 * schemas pass through cleanly (confirmed in
 * `node_modules/@browserbasehq/stagehand/dist/esm/lib/v3/zodCompat.d.ts`).
 * Barnacle uses Zod v4 via the `zod/v4` subpath export; that's compatible.
 */

import { randomUUID } from "node:crypto";

import type {
  Action,
  ActOptions,
  ActResult,
  ExtractOptions,
  ObserveOptions,
  Stagehand,
} from "@browserbasehq/stagehand";
import { z } from "zod/v4";

import {
  captureLlmCall,
  classifyLlmCallFailure,
  type LlmCallInput,
} from "@/lib/telemetry/call-capture";
import {
  CALL_TYPE_STAGEHAND_ACT,
  CALL_TYPE_STAGEHAND_EXTRACT,
  CALL_TYPE_STAGEHAND_OBSERVE,
} from "@/lib/telemetry/call-types";

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
export const ACTION_SCHEMA = z.object({
  selector: z.string(),
  description: z.string(),
  method: z.string().optional(),
  arguments: z.array(z.string()).optional(),
});

/**
 * Zod mirror of Stagehand's public `ActResult` shape. The `actions` array
 * is sometimes empty when Stagehand acted via a path that doesn't echo the
 * action back (the cascade at recon-browser.ts:3227 already handles that
 * case); we accept empty arrays here as valid per the SDK contract.
 */
export const ACT_RESULT_SCHEMA = z.object({
  success: z.boolean(),
  message: z.string(),
  actionDescription: z.string(),
  actions: z.array(ACTION_SCHEMA),
  cacheStatus: z.enum(["HIT", "MISS"]).optional(),
});

/**
 * Thrown by any guarded* wrapper when Stagehand's return value doesn't
 * `safeParse` against the schema. The `kind` is always
 * `"schema-validation-failed"` — same string the Anthropic SDK callers use
 * — so `classifyLlmCallFailure` routes it to the same NDJSON failureKind
 * bucket without any string-matching changes.
 */
export class StagehandSchemaError extends Error {
  readonly kind = "schema-validation-failed" as const;
  readonly primitive: "act" | "observe" | "extract";
  readonly zodError: z.ZodError;
  readonly rawResponse: unknown;

  constructor(
    primitive: "act" | "observe" | "extract",
    zodError: z.ZodError,
    rawResponse: unknown
  ) {
    super(`stagehand ${primitive} envelope failed schema validation: ${zodError.message}`);
    this.name = "StagehandSchemaError";
    this.primitive = primitive;
    this.zodError = zodError;
    this.rawResponse = rawResponse;
  }
}

/**
 * Stringify a possibly-circular value safely; used to populate
 * `responseContent` in telemetry without risking a `TypeError` on circular
 * Stagehand internals.
 */
function safeStringify(value: unknown, cap = 4000): string {
  try {
    return JSON.stringify(value).slice(0, cap);
  } catch {
    return String(value).slice(0, cap);
  }
}

/** Pluck the bare instruction string from either form of `act` input. */
function actInstructionOf(input: string | Action): string {
  return typeof input === "string" ? input : input.description;
}

/**
 * Schema-guarded wrapper around Stagehand's `act`. Same signature as the
 * underlying call: accepts either an instruction string or a structured
 * `Action` (from a prior `observe`). On the happy path, returns Stagehand's
 * `ActResult` verbatim. On envelope drift, throws `StagehandSchemaError`
 * and logs `failureKind: "schema-validation-failed"`.
 */
export async function guardedAct(
  stagehand: Stagehand,
  input: string | Action,
  options?: ActOptions
): Promise<ActResult> {
  const callId = randomUUID();
  const userContent = actInstructionOf(input);
  const t0 = performance.now();
  try {
    const raw = await stagehand.act(input as string, options);
    const latencyMs = performance.now() - t0;
    const parsed = ACT_RESULT_SCHEMA.safeParse(raw);
    if (!parsed.success) {
      await captureCall({
        callId,
        callType: CALL_TYPE_STAGEHAND_ACT,
        userContent,
        responseContent: safeStringify(raw),
        latencyMs,
        success: false,
        parsedOk: false,
        errorMessage: `act envelope failed schema validation: ${parsed.error.message}`,
        failureKind: "schema-validation-failed",
      });
      throw new StagehandSchemaError("act", parsed.error, raw);
    }
    await captureCall({
      callId,
      callType: CALL_TYPE_STAGEHAND_ACT,
      userContent,
      responseContent: safeStringify(parsed.data),
      latencyMs,
      success: parsed.data.success,
      parsedOk: true,
      errorMessage: null,
      failureKind: null,
    });
    return parsed.data;
  } catch (err) {
    if (err instanceof StagehandSchemaError) throw err;
    const latencyMs = performance.now() - t0;
    await captureCall({
      callId,
      callType: CALL_TYPE_STAGEHAND_ACT,
      userContent,
      responseContent: null,
      latencyMs,
      success: false,
      parsedOk: false,
      errorMessage: err instanceof Error ? err.message : String(err),
      failureKind: classifyLlmCallFailure(err),
    });
    throw err;
  }
}

/**
 * Schema-guarded wrapper around Stagehand's `observe`. Mirrors the
 * Stagehand overloads: no args, options-only, instruction-only,
 * instruction + options. On envelope drift (the `Action[]` shape changes),
 * throws `StagehandSchemaError`.
 */
export async function guardedObserve(
  stagehand: Stagehand,
  instruction?: string,
  options?: ObserveOptions
): Promise<Action[]> {
  const callId = randomUUID();
  const userContent = instruction ?? "";
  const t0 = performance.now();
  try {
    // Match Stagehand's overloads: pass instruction only when defined, so
    // the SDK falls through to its no-arg/options-only path otherwise.
    const raw =
      instruction === undefined
        ? options === undefined
          ? await stagehand.observe()
          : await stagehand.observe(options)
        : await stagehand.observe(instruction, options);
    const latencyMs = performance.now() - t0;
    const parsed = z.array(ACTION_SCHEMA).safeParse(raw);
    if (!parsed.success) {
      await captureCall({
        callId,
        callType: CALL_TYPE_STAGEHAND_OBSERVE,
        userContent,
        responseContent: safeStringify(raw),
        latencyMs,
        success: false,
        parsedOk: false,
        errorMessage: `observe envelope failed schema validation: ${parsed.error.message}`,
        failureKind: "schema-validation-failed",
      });
      throw new StagehandSchemaError("observe", parsed.error, raw);
    }
    await captureCall({
      callId,
      callType: CALL_TYPE_STAGEHAND_OBSERVE,
      userContent,
      responseContent: safeStringify(parsed.data),
      latencyMs,
      success: true,
      parsedOk: true,
      errorMessage: null,
      failureKind: null,
    });
    return parsed.data;
  } catch (err) {
    if (err instanceof StagehandSchemaError) throw err;
    const latencyMs = performance.now() - t0;
    await captureCall({
      callId,
      callType: CALL_TYPE_STAGEHAND_OBSERVE,
      userContent,
      responseContent: null,
      latencyMs,
      success: false,
      parsedOk: false,
      errorMessage: err instanceof Error ? err.message : String(err),
      failureKind: classifyLlmCallFailure(err),
    });
    throw err;
  }
}

/**
 * Schema-guarded wrapper around Stagehand's `extract` 3-arg overload. The
 * caller's Zod schema is what Stagehand asks the LLM to satisfy AND what we
 * `safeParse` against caller-side. Refuse the 1-arg / 2-arg defaults; every
 * extract call in the codebase must enforce a schema.
 */
export async function guardedExtract<T extends z.ZodTypeAny>(
  stagehand: Stagehand,
  instruction: string,
  schema: T,
  options?: ExtractOptions
): Promise<z.infer<T>> {
  const callId = randomUUID();
  const t0 = performance.now();
  try {
    // Stagehand's TypeScript types narrow the overload by argument arity;
    // its `StagehandZodSchema` union accepts both Zod v3 and v4 schemas.
    const raw = await stagehand.extract(
      instruction,
      schema as unknown as Parameters<typeof stagehand.extract>[1],
      options
    );
    const latencyMs = performance.now() - t0;
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      await captureCall({
        callId,
        callType: CALL_TYPE_STAGEHAND_EXTRACT,
        userContent: instruction,
        responseContent: safeStringify(raw),
        latencyMs,
        success: false,
        parsedOk: false,
        errorMessage: `extract envelope failed schema validation: ${parsed.error.message}`,
        failureKind: "schema-validation-failed",
      });
      throw new StagehandSchemaError("extract", parsed.error, raw);
    }
    await captureCall({
      callId,
      callType: CALL_TYPE_STAGEHAND_EXTRACT,
      userContent: instruction,
      responseContent: safeStringify(parsed.data),
      latencyMs,
      success: true,
      parsedOk: true,
      errorMessage: null,
      failureKind: null,
    });
    return parsed.data as z.infer<T>;
  } catch (err) {
    if (err instanceof StagehandSchemaError) throw err;
    const latencyMs = performance.now() - t0;
    await captureCall({
      callId,
      callType: CALL_TYPE_STAGEHAND_EXTRACT,
      userContent: instruction,
      responseContent: null,
      latencyMs,
      success: false,
      parsedOk: false,
      errorMessage: err instanceof Error ? err.message : String(err),
      failureKind: classifyLlmCallFailure(err),
    });
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
async function captureCall(
  partial: Pick<
    LlmCallInput,
    | "callId"
    | "callType"
    | "userContent"
    | "responseContent"
    | "latencyMs"
    | "success"
    | "parsedOk"
    | "errorMessage"
    | "failureKind"
  >
): Promise<void> {
  await captureLlmCall({
    ...partial,
    model: "stagehand-internal",
    systemPrompt: null,
    inputTokens: null,
    outputTokens: null,
  });
}
