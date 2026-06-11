/**
 * Zod schemas for every Anthropic LLM call site's structured output. Every
 * call in the engine goes through `client.messages.parse` + `zodOutputFormat`
 * (or equivalent) so the SDK throws on schema violation rather than handing
 * back malformed text the caller has to defensively parse. Co-locating the
 * schemas here keeps the contracts visible in one file instead of buried
 * inside ~4500-line scripts.
 *
 * Naming: each schema corresponds 1:1 to a `CALL_TYPE_*` constant in
 * `src/lib/telemetry/call-types.ts`.
 */

import { z } from "zod/v4";

/**
 * Cap on per-replan step list size. Anything beyond this is almost certainly
 * the LLM hallucinating an entire flow from scratch instead of writing the
 * minimum bridge needed to unstick the cascade. Matches the existing pre-move
 * constant value so call-site behavior is identical.
 */
export const REPLAN_MAX_STEPS = 30;

/**
 * Flow step shape consumed by every recon-flow consumer (file parsing,
 * replanner output, normalizer). A bare string is a required step; the
 * object form supports `optional` and `upload` flags.
 *
 * Moved here from recon-browser.ts so REPLAN_RESPONSE_SCHEMA can be defined
 * alongside it without recon-browser.ts having to re-export both.
 */
export const RECON_FLOW_STEP_SCHEMA = z.union([
  z.string().min(1),
  z.object({
    step: z.string().min(1),
    optional: z.boolean().default(false),
    upload: z.boolean().default(false),
  }),
]);

/**
 * Replanner response. Discriminated union on `outcome`. When the cascade has
 * exhausted all per-step healing attempts, the replanner either proposes a
 * bridge sequence (`replan` outcome) or admits the page state is
 * unrecoverable (`impossible`). The single-action constraint on each step is
 * enforced by the caller's normalizer, not the schema (the LLM emits
 * arbitrary text inside `step`; we trust the caller's downstream parse).
 */
export const REPLAN_RESPONSE_SCHEMA = z.discriminatedUnion("outcome", [
  z.object({
    outcome: z.literal("replan"),
    steps: z.array(RECON_FLOW_STEP_SCHEMA).min(1).max(REPLAN_MAX_STEPS),
  }),
  z.object({
    outcome: z.literal("impossible"),
    reason: z.string().min(1),
  }),
]);

/**
 * Rephrase response. Discriminated union on `outcome`. The pre-schema
 * contract was free text plus the magic string "IMPOSSIBLE" — fragile and
 * easy for the LLM to emit prose around. The schema makes the contract
 * explicit and parses on the API side.
 */
export const REPHRASE_RESPONSE_SCHEMA = z.discriminatedUnion("outcome", [
  z.object({
    outcome: z.literal("rewrite"),
    instruction: z.string().min(1).max(400),
  }),
  z.object({
    outcome: z.literal("impossible"),
    reason: z.string().min(1).max(200),
  }),
]);

/**
 * Patch generator response shape. Shared between `recon-flow-patch` and
 * `llm-prompt-patch` — both follow the same anchor/replacement/strategy
 * minimal-change discipline. The contract was identical at the prose level
 * before this schema; making it shared explicit Zod cleans up two parallel
 * `JSON.parse` ladders.
 *
 * Cross-field validation (anchor must exist in the artifact being patched)
 * stays at the caller because the artifact isn't known to the schema.
 */
export const PATCH_RESPONSE_SCHEMA = z.object({
  anchor: z.string().min(1),
  replacement: z.string(),
  strategy: z.string().min(1).max(120),
  pivot_reason: z.string().nullable(),
});

/**
 * Judge verdict shape. The existing judge prompt already specifies this
 * structure in prose; moving it to a Zod schema makes the contract enforced
 * by the SDK and removes the manual try/catch JSON-parse ladder.
 */
export const JUDGE_VERDICT_SCHEMA = z.object({
  schemaOk: z.boolean(),
  schemaRationale: z.string().min(1).max(400),
  factuallyGrounded: z.boolean(),
  factualRationale: z.string().min(1).max(400),
  hallucinationFree: z.boolean(),
  hallucinationRationale: z.string().min(1).max(400),
  worstOffender: z.enum(["schema", "factual", "hallucination"]).nullable().optional(),
});
