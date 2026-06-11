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
