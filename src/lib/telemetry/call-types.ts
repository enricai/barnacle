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
