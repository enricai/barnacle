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
    /**
     * When true, the step is treated as the canonical submit click for the
     * `submitEndpointPattern` verifier even when its position in the flow
     * is not the last index. The pre-2026-06-15 implementation gated the
     * pre-submit DOM probe on `isFinalStep` only, but real AppCast flows
     * put the submit click in the middle of the step list (UVA Verona's
     * Submit was at index 55/328) and follow it with post-submit
     * verification steps. With this flag set, the probe + verifier fire
     * at the actual submit click, not at the unrelated last step.
     */
    submitStep: z.boolean().default(false),
    /**
     * Optional payload-field override for the generator's splicer. When set,
     * `resolveStepPayloadField` returns this field name verbatim instead of
     * inferring one from the instruction's English label — lets a flow author
     * pin a step to a specific `payload.<field>` reference in the generated
     * browser-flow. Ignored by the recon runtime; consumed only by
     * recon-generate.ts.
     */
    payloadField: z.string().optional(),
    /**
     * Optional opt-out for the generator's splicer. When true, the generator
     * leaves the instruction literal even if its label would otherwise match a
     * candidate payload field. Ignored by the recon runtime.
     */
    payloadFieldNone: z.boolean().optional(),
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

/**
 * Submit-verification verdict. Replaces the per-site `submitEndpointPattern`
 * regex. Discriminated union forces the LLM to commit to verified=true|false
 * — no in-between "maybe" state.
 *
 * The verified=true branch requires populating three signal fields (any can
 * be null but at least one of dom_signal / url_signal SHOULD be non-null per
 * the strict system prompt). The verifier's `rationale` must cite the
 * strongest signal — keeps Haiku honest about why it ruled success.
 *
 * The verified=false branch requires a reason — keeps Haiku from waving
 * failures away without explanation, and gives the rephrase prompt
 * downstream a structured signal about what to look for.
 *
 * Empirically validated 2026-06-11 on two real production failure dumps
 * (one wrongly-flagged-as-fail, one genuinely-stuck) — both verdicts
 * correct, both rationale fields coherent.
 */
export const SUBMIT_VERDICT_SCHEMA = z.discriminatedUnion("verified", [
  z.object({
    verified: z.literal(true),
    network_signal: z
      .object({
        url: z.string().max(2048),
        status: z.number(),
        method: z.string().max(16),
      })
      .nullable(),
    dom_signal: z.string().max(200).nullable(),
    url_signal: z.string().max(200).nullable(),
    rationale: z.string().min(1).max(400),
  }),
  z.object({
    verified: z.literal(false),
    reason: z.string().min(1).max(400),
  }),
]);

/**
 * Invalid-field detection verdict. Replaces INVALID_CLASS_RX regex.
 * `present` is the top-level boolean so a downstream consumer can
 * short-circuit on "no invalid fields here" without iterating `fields`.
 * `fields` carries the discovered structural markers per-container so
 * the rephrase prompt can build its INTERACTIVE TARGETS section.
 *
 * Strict prompting requires: structural marker (class containing
 * "invalid", aria-invalid="true", data-invalid, or visible error
 * container near input). Visual-only styling does NOT count.
 */
export const INVALID_FIELDS_SCHEMA = z.object({
  present: z.boolean(),
  fields: z
    .array(
      z.object({
        containerXpath: z.string().min(1),
        label: z.string().nullable(),
        markerKind: z.enum(["class", "aria", "data", "error-container", "other"]),
        framework: z.enum(["angular", "react", "vue", "mantine", "chakra", "bootstrap", "other"]),
      })
    )
    .max(50),
});

/**
 * Modal-priority verdict. Replaces MODAL_PRIORITY_RX keyword regex over
 * Stagehand's English description strings. Returns indices into the
 * caller-supplied unfocused-observe array — the engine just re-sorts
 * its own list, the LLM doesn't see selectors or have to echo them
 * back.
 *
 * Strict prompting requires: structurally blocking the form. Cookie
 * banners and welcome modals ARE priority. Always-visible panels and
 * sidebars are NOT.
 */
export const MODAL_PRIORITY_SCHEMA = z.object({
  priorityIndices: z.array(z.number().int().min(0)).max(50),
  rationale: z.string().min(1).max(400),
});

/**
 * Visible-error-message extraction verdict. Replaces `errorPattern`
 * regex. Each entry carries the text, an optional field-name hint,
 * and a severity ranking — the rephrase prompt today renders these as
 * the VISIBLE ERROR / REQUIRED-FIELD MESSAGES section.
 *
 * Strict prompting: structurally-marked error containers + visible text
 * only. Skip placeholder text, help text, and inactive tooltips.
 */
export const ERROR_MESSAGES_SCHEMA = z.object({
  messages: z
    .array(
      z.object({
        text: z.string().min(1).max(400),
        fieldHint: z.string().nullable(),
        severity: z.enum(["error", "warning", "info"]),
      })
    )
    .max(50),
});

/**
 * Select-option picker verdict. When a flow step's hardcoded dropdown answer
 * doesn't exist in a given requisition's option list (per-req variance —
 * e.g. an ER-flavored answer on a Cardiac job), this judge picks the most
 * plausible AVAILABLE option so the required question can be answered and the
 * wizard advances. `selectIndex` picks which candidate dropdown answers the
 * question (or null when none does); `optionIndex` picks the option within that
 * dropdown (null when `selectIndex` is null).
 */
export const SELECT_OPTION_SCHEMA = z.object({
  /** Index into the caller-supplied candidate dropdowns — which dropdown on the
   *  page answers the question. Null when none does. */
  selectIndex: z.number().int().min(0).nullable(),
  /** Index into that dropdown's options — which option to choose. Null when
   *  selectIndex is null. */
  optionIndex: z.number().int().min(0).nullable(),
  reason: z.string().min(1).max(400),
});
