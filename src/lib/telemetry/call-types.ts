/**
 * Canonical call_type string constants for all LLM call sites Barnacle owns
 * directly. Referencing these avoids magic strings in call sites, tests, and
 * the judge/self-heal skills (feat-004/005).
 */

/** Attempt-4 rephrase inside the recon-browser step-healing cascade. */
export const CALL_TYPE_RECON_REPHRASE = "recon-rephrase";

/** Global replan after a step terminally fails in recon-browser. */
export const CALL_TYPE_RECON_REPLAN = "recon-replan";

/** Patch proposal from the recon-flow-patch-generator (recon-heal). */
export const CALL_TYPE_RECON_FLOW_PATCH = "recon-flow-patch";

/** Patch proposal from the llm-call-patch-generator (llm-heal). */
export const CALL_TYPE_LLM_PROMPT_PATCH = "llm-prompt-patch";

/**
 * Stagehand `act()` envelope-validation. Captured by the guardedAct wrapper
 * so every Stagehand-driven LLM call lands in the same NDJSON sink as
 * Barnacle's own Anthropic-SDK calls. Per the user directive that every
 * LLM-touching surface enforces a schema, every act call is logged
 * regardless of outcome — full parity with our other call-type telemetry.
 */
export const CALL_TYPE_STAGEHAND_ACT = "stagehand-act";

/** Stagehand `observe()` envelope-validation. See CALL_TYPE_STAGEHAND_ACT. */
export const CALL_TYPE_STAGEHAND_OBSERVE = "stagehand-observe";

/** Stagehand `extract()` schema-enforced call. See CALL_TYPE_STAGEHAND_ACT. */
export const CALL_TYPE_STAGEHAND_EXTRACT = "stagehand-extract";

/**
 * Haiku 4.5 judge for submit-success verification. Replaces the per-site
 * regex (`submitEndpointPattern`) that mislabeled successful submits as
 * failures whenever a site used a different POST URL than the regex
 * expected. The judge receives evidence (recent network captures, page
 * URL/title, unfocused observe, site criteria) and returns a discriminated
 * verdict — verified=true requires multi-signal corroboration to prevent
 * lax false positives.
 */
export const CALL_TYPE_JUDGE_SUBMIT_VERIFY = "judge-submit-verify";

/**
 * Haiku 4.5 judge for invalid-field detection. Replaces INVALID_CLASS_RX
 * (limited to ng-invalid / mat-form-field-invalid / is-invalid class
 * signatures) with structured detection covering aria-invalid attributes,
 * data-invalid attributes, and arbitrary framework variants we haven't
 * seen yet. Strict prompting: only mark a field present when there's a
 * structural invalid marker, not just visual red-border styling.
 */
export const CALL_TYPE_JUDGE_INVALID_FIELDS = "judge-invalid-fields";

/**
 * Haiku 4.5 judge for modal-priority ranking of unfocused-observe
 * candidates. Replaces MODAL_PRIORITY_RX (keyword regex over English
 * descriptions). Surfaces modals/dialogs/overlays that BLOCK the form,
 * skips always-visible panels and sidebars that don't.
 */
export const CALL_TYPE_JUDGE_MODAL_PRIORITY = "judge-modal-priority";

/**
 * Haiku 4.5 judge for visible-error-message extraction. Replaces
 * errorPattern (class-name regex). Extracts structurally-marked error
 * messages with field hints and severity, skipping placeholder/help text.
 */
export const CALL_TYPE_JUDGE_ERROR_MESSAGES = "judge-error-messages";

/**
 * Haiku 4.5 judge that picks the best AVAILABLE option for a required
 * dropdown when the flow's hardcoded answer text doesn't exist in this
 * requisition's option list (per-req screening-question variance). Used by
 * `trySelectPrimitive`'s LLM fallback.
 */
export const CALL_TYPE_JUDGE_SELECT_OPTION = "judge-select-option";
