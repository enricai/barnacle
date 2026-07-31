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

import { randomUUID } from "node:crypto";

import type {
  Action,
  ActOptions,
  ActResult,
  ExtractOptions,
  ObserveOptions,
  Stagehand,
} from "@browserbasehq/stagehand";
import { LRUCache } from "lru-cache";
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
export const ACTION_SCHEMA = z.object({
  selector: z.string(),
  description: z.string(),
  method: z.string().optional(),
  arguments: z.array(z.string()).optional(),
});

/**
 * Zod mirror of Stagehand's public `ActResult` shape. The `actions` array
 * is sometimes empty when Stagehand acted via a path that doesn't echo the
 * action back; the cascade's resolvedAction fallback already handles that
 * case. We accept empty arrays here as valid per the SDK contract.
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
 * Per-run cache of `stagehand-observe` results, keyed by instruction string.
 * Reduces the ~4s cost-per-call (DOM hybrid-snapshot extraction + Haiku LLM
 * inference inside Stagehand) when the cascade re-asks for the same
 * accessibility-tree analysis. Empirically the per-step probe and the
 * cascade's attempt-2 observe-act both run the same instruction within
 * ~10s of each other; the cross-step pattern observes the same form
 * questions across multiple flow passes after the user revisits a section.
 *
 * Selector stability across page state changes was verified on AppCast's
 * applyboard (10 distinct instruction patterns × multiple observations over
 * 53 min returned byte-identical xpath strings each). When the DOM IS
 * perturbed (a click changed a radio state, or page navigated), the caller
 * `guardedAct` evicts affected entries by selector on successful action
 * (a click that flipped a radio's state changes what subsequent observes
 * would return for the same instruction).
 *
 * Per-run scoped; instantiate via `newObserveCache()` and pass through the
 * cascade. Engine-only; no site-specific knowledge.
 */
export interface ObserveCache {
  readonly byInstruction: LRUCache<string, Action[]>;
  readonly stats: { hits: number; misses: number; invalidations: number };
}

/**
 * Create a fresh per-run observe cache.
 *
 * Uses `lru-cache` per CLAUDE.md's battle-tested-libraries rule (mirrors
 * `src/cache/response-cache.ts`'s usage pattern). `max: 256` is ~2.3× the
 * empirical unique-instruction count (112) measured in the 2026-06-14
 * AppCast Job 1 run — comfortable headroom for larger flows with bounded
 * memory (~256 × ~1KB Action[] ≈ ~256KB worst case). No `ttl`: selector
 * stability was verified across 10 distinct instructions × 53 minutes; the
 * bounded-LRU semantics give us memory safety without time-based churn.
 * If a future site has unstable selectors, adding `ttl: 300_000` (5 min)
 * is a one-line change.
 */
export function newObserveCache(): ObserveCache {
  return {
    byInstruction: new LRUCache<string, Action[]>({ max: 256 }),
    stats: { hits: 0, misses: 0, invalidations: 0 },
  };
}

/**
 * Evict any cached observe result whose `Action[]` contains the given
 * selector. Called after a successful `guardedAct` because the act may have
 * mutated the element's state (radio toggled, button disabled), making
 * subsequent observe results different from the cached version. Verified
 * scoped: typical AppCast act-success evicts 2-3 cache entries (the same
 * radio element appears in observes for different conditional flow steps
 * that all target the same question).
 */
function invalidateObserveCacheForSelector(cache: ObserveCache, selector: string): void {
  if (!selector) return;
  for (const [instruction, actions] of cache.byInstruction) {
    if (actions.some((a) => a.selector === selector)) {
      cache.byInstruction.delete(instruction);
      cache.stats.invalidations += 1;
    }
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
  options?: ActOptions,
  captureFn?: StagehandCaptureFn,
  cache?: ObserveCache
): Promise<ActResult> {
  const callId = randomUUID();
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
    const raw =
      typeof input === "string"
        ? await stagehand.act(input, options)
        : await stagehand.act(input, options);
    const latencyMs = performance.now() - t0;
    const parsed = ACT_RESULT_SCHEMA.safeParse(raw);
    if (!parsed.success) {
      await captureCall(
        {
          callId,
          callType: CALL_TYPE_STAGEHAND_ACT,
          userContent,
          responseContent: safeStringify(raw),
          latencyMs,
          success: false,
          parsedOk: false,
          errorMessage: `act envelope failed schema validation: ${parsed.error.message}`,
          failureKind: "schema-validation-failed",
        },
        captureFn
      );
      throw new StagehandSchemaError("act", parsed.error, raw);
    }
    await captureCall(
      {
        callId,
        callType: CALL_TYPE_STAGEHAND_ACT,
        userContent,
        responseContent: safeStringify(parsed.data),
        latencyMs,
        success: parsed.data.success,
        parsedOk: true,
        errorMessage: null,
        failureKind: null,
      },
      captureFn
    );
    // A successful act mutates the element's state (radio toggled, button
    // disabled), so subsequent observes for any question that referenced
    // this selector would return a different element. Verified scoped:
    // typical AppCast act-success evicts 2-3 cache entries — the same
    // element appears in observes for several conditional flow steps that
    // all target the same DOM target, all correctly evicted.
    if (cache && parsed.data.success) {
      for (const action of parsed.data.actions ?? []) {
        if (action.selector) invalidateObserveCacheForSelector(cache, action.selector);
      }
    }
    return parsed.data;
  } catch (err) {
    if (err instanceof StagehandSchemaError) throw err;
    const latencyMs = performance.now() - t0;
    await captureCall(
      {
        callId,
        callType: CALL_TYPE_STAGEHAND_ACT,
        userContent,
        responseContent: null,
        latencyMs,
        success: false,
        parsedOk: false,
        errorMessage: err instanceof Error ? err.message : String(err),
        failureKind: classifyLlmCallFailure(err),
      },
      captureFn
    );
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
  options?: ObserveOptions,
  captureFn?: StagehandCaptureFn,
  cache?: ObserveCache
): Promise<Action[]> {
  const callId = randomUUID();
  const userContent = instruction ?? "";
  // Cache lookup: skip Stagehand's DOM hybrid-snapshot AND the LLM call
  // entirely on hit. The cache only holds results for the same instruction
  // string — empty-string key (unfocused observes) and `ignoreSelectors`
  // calls (cascade attempt 4 = observe-act-exclude) bypass because the
  // caller wants Stagehand to re-run with different inputs. Cache misses
  // fall through to fresh observe and get populated post-parse below.
  if (cache && instruction !== undefined && !options?.ignoreSelectors?.length) {
    const cached = cache.byInstruction.get(userContent);
    // Only a NON-EMPTY cached result is a hit. An empty [] must never satisfy
    // a lookup: `if ([])` is truthy in JS, so without the length guard a probe
    // whose focused observe returned [] would replay that stale [] to every
    // later observe of the same instruction (e.g. the cascade's attempt-2),
    // which then never re-observes the live DOM. Empties always re-run fresh.
    if (cached && cached.length > 0) {
      cache.stats.hits += 1;
      await captureCall(
        {
          callId,
          callType: CALL_TYPE_STAGEHAND_OBSERVE,
          userContent,
          responseContent: safeStringify(cached),
          latencyMs: 0,
          success: true,
          parsedOk: true,
          errorMessage: null,
          failureKind: null,
        },
        captureFn
      );
      return cached;
    }
    cache.stats.misses += 1;
  }
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
      await captureCall(
        {
          callId,
          callType: CALL_TYPE_STAGEHAND_OBSERVE,
          userContent,
          responseContent: safeStringify(raw),
          latencyMs,
          success: false,
          parsedOk: false,
          errorMessage: `observe envelope failed schema validation: ${parsed.error.message}`,
          failureKind: "schema-validation-failed",
        },
        captureFn
      );
      throw new StagehandSchemaError("observe", parsed.error, raw);
    }
    await captureCall(
      {
        callId,
        callType: CALL_TYPE_STAGEHAND_OBSERVE,
        userContent,
        responseContent: safeStringify(parsed.data),
        latencyMs,
        success: true,
        parsedOk: true,
        errorMessage: null,
        failureKind: null,
      },
      captureFn
    );
    // Populate cache on miss. Same gating as the lookup above: only store
    // focused observes (instruction set) without `ignoreSelectors`, since
    // those are the only calls that benefit from being replayed verbatim.
    // NEVER cache an empty result: an [] entry is never invalidated
    // (invalidateObserveCacheForSelector only evicts entries containing a
    // matching selector) and would poison every later observe of the same
    // instruction. Under-returning observes (React/MUI focused-observe misses)
    // must always re-run fresh so a later attempt can resolve the element.
    if (
      cache &&
      instruction !== undefined &&
      !options?.ignoreSelectors?.length &&
      parsed.data.length > 0
    ) {
      cache.byInstruction.set(userContent, parsed.data);
    }
    return parsed.data;
  } catch (err) {
    if (err instanceof StagehandSchemaError) throw err;
    const latencyMs = performance.now() - t0;
    await captureCall(
      {
        callId,
        callType: CALL_TYPE_STAGEHAND_OBSERVE,
        userContent,
        responseContent: null,
        latencyMs,
        success: false,
        parsedOk: false,
        errorMessage: err instanceof Error ? err.message : String(err),
        failureKind: classifyLlmCallFailure(err),
      },
      captureFn
    );
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
  options?: ExtractOptions,
  captureFn?: StagehandCaptureFn
): Promise<z.infer<T>> {
  const callId = randomUUID();
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
    const raw = await stagehand.extract(
      instruction,
      schema as unknown as Parameters<typeof stagehand.extract>[1],
      options
    );
    const latencyMs = performance.now() - t0;
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      await captureCall(
        {
          callId,
          callType: CALL_TYPE_STAGEHAND_EXTRACT,
          userContent: instruction,
          responseContent: safeStringify(raw),
          latencyMs,
          success: false,
          parsedOk: false,
          errorMessage: `extract envelope failed schema validation: ${parsed.error.message}`,
          failureKind: "schema-validation-failed",
        },
        captureFn
      );
      throw new StagehandSchemaError("extract", parsed.error, raw);
    }
    await captureCall(
      {
        callId,
        callType: CALL_TYPE_STAGEHAND_EXTRACT,
        userContent: instruction,
        responseContent: safeStringify(parsed.data),
        latencyMs,
        success: true,
        parsedOk: true,
        errorMessage: null,
        failureKind: null,
      },
      captureFn
    );
    return parsed.data as z.infer<T>;
  } catch (err) {
    if (err instanceof StagehandSchemaError) throw err;
    const latencyMs = performance.now() - t0;
    await captureCall(
      {
        callId,
        callType: CALL_TYPE_STAGEHAND_EXTRACT,
        userContent: instruction,
        responseContent: null,
        latencyMs,
        success: false,
        parsedOk: false,
        errorMessage: err instanceof Error ? err.message : String(err),
        failureKind: classifyLlmCallFailure(err),
      },
      captureFn
    );
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
  >,
  captureFn: StagehandCaptureFn = captureLlmCall
): Promise<void> {
  await captureFn({
    ...partial,
    model: "stagehand-internal",
    systemPrompt: null,
    inputTokens: null,
    outputTokens: null,
  });
}
