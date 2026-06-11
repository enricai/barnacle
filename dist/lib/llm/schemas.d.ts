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
export declare const REPLAN_MAX_STEPS = 30;
/**
 * Flow step shape consumed by every recon-flow consumer (file parsing,
 * replanner output, normalizer). A bare string is a required step; the
 * object form supports `optional` and `upload` flags.
 *
 * Moved here from recon-browser.ts so REPLAN_RESPONSE_SCHEMA can be defined
 * alongside it without recon-browser.ts having to re-export both.
 */
export declare const RECON_FLOW_STEP_SCHEMA: z.ZodUnion<readonly [z.ZodString, z.ZodObject<{
    step: z.ZodString;
    optional: z.ZodDefault<z.ZodBoolean>;
    upload: z.ZodDefault<z.ZodBoolean>;
}, z.core.$strip>]>;
/**
 * Replanner response. Discriminated union on `outcome`. When the cascade has
 * exhausted all per-step healing attempts, the replanner either proposes a
 * bridge sequence (`replan` outcome) or admits the page state is
 * unrecoverable (`impossible`). The single-action constraint on each step is
 * enforced by the caller's normalizer, not the schema (the LLM emits
 * arbitrary text inside `step`; we trust the caller's downstream parse).
 */
export declare const REPLAN_RESPONSE_SCHEMA: z.ZodDiscriminatedUnion<[z.ZodObject<{
    outcome: z.ZodLiteral<"replan">;
    steps: z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodObject<{
        step: z.ZodString;
        optional: z.ZodDefault<z.ZodBoolean>;
        upload: z.ZodDefault<z.ZodBoolean>;
    }, z.core.$strip>]>>;
}, z.core.$strip>, z.ZodObject<{
    outcome: z.ZodLiteral<"impossible">;
    reason: z.ZodString;
}, z.core.$strip>]>;
/**
 * Rephrase response. Discriminated union on `outcome`. The pre-schema
 * contract was free text plus the magic string "IMPOSSIBLE" — fragile and
 * easy for the LLM to emit prose around. The schema makes the contract
 * explicit and parses on the API side.
 */
export declare const REPHRASE_RESPONSE_SCHEMA: z.ZodDiscriminatedUnion<[z.ZodObject<{
    outcome: z.ZodLiteral<"rewrite">;
    instruction: z.ZodString;
}, z.core.$strip>, z.ZodObject<{
    outcome: z.ZodLiteral<"impossible">;
    reason: z.ZodString;
}, z.core.$strip>]>;
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
export declare const PATCH_RESPONSE_SCHEMA: z.ZodObject<{
    anchor: z.ZodString;
    replacement: z.ZodString;
    strategy: z.ZodString;
    pivot_reason: z.ZodNullable<z.ZodString>;
}, z.core.$strip>;
/**
 * Judge verdict shape. The existing judge prompt already specifies this
 * structure in prose; moving it to a Zod schema makes the contract enforced
 * by the SDK and removes the manual try/catch JSON-parse ladder.
 */
export declare const JUDGE_VERDICT_SCHEMA: z.ZodObject<{
    schemaOk: z.ZodBoolean;
    schemaRationale: z.ZodString;
    factuallyGrounded: z.ZodBoolean;
    factualRationale: z.ZodString;
    hallucinationFree: z.ZodBoolean;
    hallucinationRationale: z.ZodString;
    worstOffender: z.ZodOptional<z.ZodNullable<z.ZodEnum<{
        schema: "schema";
        factual: "factual";
        hallucination: "hallucination";
    }>>>;
}, z.core.$strip>;
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
export declare const SUBMIT_VERDICT_SCHEMA: z.ZodDiscriminatedUnion<[z.ZodObject<{
    verified: z.ZodLiteral<true>;
    network_signal: z.ZodNullable<z.ZodObject<{
        url: z.ZodString;
        status: z.ZodNumber;
        method: z.ZodString;
    }, z.core.$strip>>;
    dom_signal: z.ZodNullable<z.ZodString>;
    url_signal: z.ZodNullable<z.ZodString>;
    rationale: z.ZodString;
}, z.core.$strip>, z.ZodObject<{
    verified: z.ZodLiteral<false>;
    reason: z.ZodString;
}, z.core.$strip>]>;
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
export declare const INVALID_FIELDS_SCHEMA: z.ZodObject<{
    present: z.ZodBoolean;
    fields: z.ZodArray<z.ZodObject<{
        containerXpath: z.ZodString;
        label: z.ZodNullable<z.ZodString>;
        markerKind: z.ZodEnum<{
            data: "data";
            class: "class";
            aria: "aria";
            "error-container": "error-container";
            other: "other";
        }>;
        framework: z.ZodEnum<{
            other: "other";
            angular: "angular";
            react: "react";
            vue: "vue";
            mantine: "mantine";
            chakra: "chakra";
            bootstrap: "bootstrap";
        }>;
    }, z.core.$strip>>;
}, z.core.$strip>;
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
export declare const MODAL_PRIORITY_SCHEMA: z.ZodObject<{
    priorityIndices: z.ZodArray<z.ZodNumber>;
    rationale: z.ZodString;
}, z.core.$strip>;
/**
 * Visible-error-message extraction verdict. Replaces `errorPattern`
 * regex. Each entry carries the text, an optional field-name hint,
 * and a severity ranking — the rephrase prompt today renders these as
 * the VISIBLE ERROR / REQUIRED-FIELD MESSAGES section.
 *
 * Strict prompting: structurally-marked error containers + visible text
 * only. Skip placeholder text, help text, and inactive tooltips.
 */
export declare const ERROR_MESSAGES_SCHEMA: z.ZodObject<{
    messages: z.ZodArray<z.ZodObject<{
        text: z.ZodString;
        fieldHint: z.ZodNullable<z.ZodString>;
        severity: z.ZodEnum<{
            info: "info";
            error: "error";
            warning: "warning";
        }>;
    }, z.core.$strip>>;
}, z.core.$strip>;
