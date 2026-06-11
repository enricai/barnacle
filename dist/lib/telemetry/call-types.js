"use strict";
/**
 * Canonical call_type string constants for all LLM call sites Barnacle owns
 * directly. Referencing these avoids magic strings in call sites, tests, and
 * the judge/self-heal skills (feat-004/005).
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.CALL_TYPE_JUDGE_ERROR_MESSAGES = exports.CALL_TYPE_JUDGE_MODAL_PRIORITY = exports.CALL_TYPE_JUDGE_INVALID_FIELDS = exports.CALL_TYPE_JUDGE_SUBMIT_VERIFY = exports.CALL_TYPE_STAGEHAND_EXTRACT = exports.CALL_TYPE_STAGEHAND_OBSERVE = exports.CALL_TYPE_STAGEHAND_ACT = exports.CALL_TYPE_LLM_PROMPT_PATCH = exports.CALL_TYPE_RECON_FLOW_PATCH = exports.CALL_TYPE_RECON_REPLAN = exports.CALL_TYPE_RECON_REPHRASE = void 0;
/** Attempt-4 rephrase inside the recon-browser step-healing cascade. */
exports.CALL_TYPE_RECON_REPHRASE = "recon-rephrase";
/** Global replan after a step terminally fails in recon-browser. */
exports.CALL_TYPE_RECON_REPLAN = "recon-replan";
/** Patch proposal from the recon-flow-patch-generator (recon-heal). */
exports.CALL_TYPE_RECON_FLOW_PATCH = "recon-flow-patch";
/** Patch proposal from the llm-call-patch-generator (llm-heal). */
exports.CALL_TYPE_LLM_PROMPT_PATCH = "llm-prompt-patch";
/**
 * Stagehand `act()` envelope-validation. Captured by the guardedAct wrapper
 * so every Stagehand-driven LLM call lands in the same NDJSON sink as
 * Barnacle's own Anthropic-SDK calls. Per the user directive that every
 * LLM-touching surface enforces a schema, every act call is logged
 * regardless of outcome — full parity with our other call-type telemetry.
 */
exports.CALL_TYPE_STAGEHAND_ACT = "stagehand-act";
/** Stagehand `observe()` envelope-validation. See CALL_TYPE_STAGEHAND_ACT. */
exports.CALL_TYPE_STAGEHAND_OBSERVE = "stagehand-observe";
/** Stagehand `extract()` schema-enforced call. See CALL_TYPE_STAGEHAND_ACT. */
exports.CALL_TYPE_STAGEHAND_EXTRACT = "stagehand-extract";
/**
 * Haiku 4.5 judge for submit-success verification. Replaces the per-site
 * regex (`submitEndpointPattern`) that mislabeled successful submits as
 * failures whenever AppCast used a different POST URL than the regex
 * expected. The judge receives evidence (recent network captures, page
 * URL/title, unfocused observe, site criteria) and returns a discriminated
 * verdict — verified=true requires multi-signal corroboration to prevent
 * lax false positives.
 */
exports.CALL_TYPE_JUDGE_SUBMIT_VERIFY = "judge-submit-verify";
/**
 * Haiku 4.5 judge for invalid-field detection. Replaces INVALID_CLASS_RX
 * (limited to ng-invalid / mat-form-field-invalid / is-invalid class
 * signatures) with structured detection covering aria-invalid attributes,
 * data-invalid attributes, and arbitrary framework variants we haven't
 * seen yet. Strict prompting: only mark a field present when there's a
 * structural invalid marker, not just visual red-border styling.
 */
exports.CALL_TYPE_JUDGE_INVALID_FIELDS = "judge-invalid-fields";
/**
 * Haiku 4.5 judge for modal-priority ranking of unfocused-observe
 * candidates. Replaces MODAL_PRIORITY_RX (keyword regex over English
 * descriptions). Surfaces modals/dialogs/overlays that BLOCK the form,
 * skips always-visible panels and sidebars that don't.
 */
exports.CALL_TYPE_JUDGE_MODAL_PRIORITY = "judge-modal-priority";
/**
 * Haiku 4.5 judge for visible-error-message extraction. Replaces
 * errorPattern (class-name regex). Extracts structurally-marked error
 * messages with field hints and severity, skipping placeholder/help text.
 */
exports.CALL_TYPE_JUDGE_ERROR_MESSAGES = "judge-error-messages";
//# sourceMappingURL=call-types.js.map