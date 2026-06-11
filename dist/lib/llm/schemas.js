"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.ERROR_MESSAGES_SCHEMA = exports.MODAL_PRIORITY_SCHEMA = exports.INVALID_FIELDS_SCHEMA = exports.SUBMIT_VERDICT_SCHEMA = exports.JUDGE_VERDICT_SCHEMA = exports.PATCH_RESPONSE_SCHEMA = exports.REPHRASE_RESPONSE_SCHEMA = exports.REPLAN_RESPONSE_SCHEMA = exports.RECON_FLOW_STEP_SCHEMA = exports.REPLAN_MAX_STEPS = void 0;
const v4_1 = require("zod/v4");
/**
 * Cap on per-replan step list size. Anything beyond this is almost certainly
 * the LLM hallucinating an entire flow from scratch instead of writing the
 * minimum bridge needed to unstick the cascade. Matches the existing pre-move
 * constant value so call-site behavior is identical.
 */
exports.REPLAN_MAX_STEPS = 30;
/**
 * Flow step shape consumed by every recon-flow consumer (file parsing,
 * replanner output, normalizer). A bare string is a required step; the
 * object form supports `optional` and `upload` flags.
 *
 * Moved here from recon-browser.ts so REPLAN_RESPONSE_SCHEMA can be defined
 * alongside it without recon-browser.ts having to re-export both.
 */
exports.RECON_FLOW_STEP_SCHEMA = v4_1.z.union([
    v4_1.z.string().min(1),
    v4_1.z.object({
        step: v4_1.z.string().min(1),
        optional: v4_1.z.boolean().default(false),
        upload: v4_1.z.boolean().default(false),
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
exports.REPLAN_RESPONSE_SCHEMA = v4_1.z.discriminatedUnion("outcome", [
    v4_1.z.object({
        outcome: v4_1.z.literal("replan"),
        steps: v4_1.z.array(exports.RECON_FLOW_STEP_SCHEMA).min(1).max(exports.REPLAN_MAX_STEPS),
    }),
    v4_1.z.object({
        outcome: v4_1.z.literal("impossible"),
        reason: v4_1.z.string().min(1),
    }),
]);
/**
 * Rephrase response. Discriminated union on `outcome`. The pre-schema
 * contract was free text plus the magic string "IMPOSSIBLE" — fragile and
 * easy for the LLM to emit prose around. The schema makes the contract
 * explicit and parses on the API side.
 */
exports.REPHRASE_RESPONSE_SCHEMA = v4_1.z.discriminatedUnion("outcome", [
    v4_1.z.object({
        outcome: v4_1.z.literal("rewrite"),
        instruction: v4_1.z.string().min(1).max(400),
    }),
    v4_1.z.object({
        outcome: v4_1.z.literal("impossible"),
        reason: v4_1.z.string().min(1).max(200),
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
exports.PATCH_RESPONSE_SCHEMA = v4_1.z.object({
    anchor: v4_1.z.string().min(1),
    replacement: v4_1.z.string(),
    strategy: v4_1.z.string().min(1).max(120),
    pivot_reason: v4_1.z.string().nullable(),
});
/**
 * Judge verdict shape. The existing judge prompt already specifies this
 * structure in prose; moving it to a Zod schema makes the contract enforced
 * by the SDK and removes the manual try/catch JSON-parse ladder.
 */
exports.JUDGE_VERDICT_SCHEMA = v4_1.z.object({
    schemaOk: v4_1.z.boolean(),
    schemaRationale: v4_1.z.string().min(1).max(400),
    factuallyGrounded: v4_1.z.boolean(),
    factualRationale: v4_1.z.string().min(1).max(400),
    hallucinationFree: v4_1.z.boolean(),
    hallucinationRationale: v4_1.z.string().min(1).max(400),
    worstOffender: v4_1.z.enum(["schema", "factual", "hallucination"]).nullable().optional(),
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
exports.SUBMIT_VERDICT_SCHEMA = v4_1.z.discriminatedUnion("verified", [
    v4_1.z.object({
        verified: v4_1.z.literal(true),
        network_signal: v4_1.z
            .object({
            url: v4_1.z.string().max(2048),
            status: v4_1.z.number(),
            method: v4_1.z.string().max(16),
        })
            .nullable(),
        dom_signal: v4_1.z.string().max(200).nullable(),
        url_signal: v4_1.z.string().max(200).nullable(),
        rationale: v4_1.z.string().min(1).max(400),
    }),
    v4_1.z.object({
        verified: v4_1.z.literal(false),
        reason: v4_1.z.string().min(1).max(400),
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
exports.INVALID_FIELDS_SCHEMA = v4_1.z.object({
    present: v4_1.z.boolean(),
    fields: v4_1.z
        .array(v4_1.z.object({
        containerXpath: v4_1.z.string().min(1),
        label: v4_1.z.string().nullable(),
        markerKind: v4_1.z.enum(["class", "aria", "data", "error-container", "other"]),
        framework: v4_1.z.enum(["angular", "react", "vue", "mantine", "chakra", "bootstrap", "other"]),
    }))
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
exports.MODAL_PRIORITY_SCHEMA = v4_1.z.object({
    priorityIndices: v4_1.z.array(v4_1.z.number().int().min(0)).max(50),
    rationale: v4_1.z.string().min(1).max(400),
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
exports.ERROR_MESSAGES_SCHEMA = v4_1.z.object({
    messages: v4_1.z
        .array(v4_1.z.object({
        text: v4_1.z.string().min(1).max(400),
        fieldHint: v4_1.z.string().nullable(),
        severity: v4_1.z.enum(["error", "warning", "info"]),
    }))
        .max(50),
});
//# sourceMappingURL=schemas.js.map