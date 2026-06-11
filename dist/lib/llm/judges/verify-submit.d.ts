/**
 * Submit-verification judge. Replaces the per-site `submitEndpointPattern`
 * regex with a Haiku 4.5 structured-output call that judges success across
 * multiple corroborating signals (network 2xx + DOM success component + URL
 * transition + page title).
 *
 * Empirically validated 2026-06-11 on two production failure cases:
 *  - Case A (was wrongly flagged as failure by the regex): verdict=true,
 *    correctly identified dom_signal="uapp-universal-submitted-page" and
 *    url_signal="/applyboard/applied".
 *  - Case B (genuinely stuck, 10 ng-invalid markers, no success DOM):
 *    verdict=false with a coherent reason about why submission failed.
 *
 * Strictness rule baked into the system prompt: verified=true requires at
 * least one DOM/URL/title signal of post-submit state. A 2xx alone is NOT
 * sufficient (could be telemetry). The judge defaults to verified=false
 * when signals are ambiguous — strong evidence, not lax permission.
 */
import type Anthropic from "@anthropic-ai/sdk";
import type { z } from "zod/v4";
import { type JudgeCaptureFn } from "../../../lib/llm/judge";
import { SUBMIT_VERDICT_SCHEMA } from "../../../lib/llm/schemas";
/**
 * System prompt for the submit-verifier. The strictness rules are
 * intentionally explicit and multi-signal — the empirical replay confirmed
 * Haiku follows them honestly on both true-success and genuine-failure cases.
 */
declare const SUBMIT_VERIFY_SYSTEM_PROMPT = "You are a strict submit-verifier for browser-automated job applications. Given evidence about what happened after a Submit click, decide whether the submission actually succeeded.\n\nStrictness rule for verified=true:\n- You need at least ONE strong DOM/URL/title signal: a post-submit success component is visible in the page DOM (matching one of submitted-state selectors or a generic post-submit marker like *-submitted-page, *-thank-you, *-confirmation), OR the page title contains a confirmation phrase (\"Thank you\", \"Application submitted\", \"Submitted\", \"Confirmation\"), OR the URL transitioned to a success path (any of the success URL fragments supplied, or generic patterns like \"/applied\", \"/submitted\", \"/confirmation\", \"/thank-you\").\n- A 2xx POST/PUT/DELETE to the site's own backend (matching one of the supplied ownBackendHostnames) STRENGTHENS the case but is not required on its own \u2014 sometimes the network capture window misses the submit POST because the SPA navigates faster than the recorder.\n- A 2xx network request alone, with NO DOM/URL/title indication of success, is INSUFFICIENT. Could be telemetry. Set verified=false in that case.\n- If only error indicators are present (4xx, 5xx, error containers, the form is still visible with invalid markers), set verified=false with a reason.\n- When ambiguous, set verified=false with a reason. Be strict, not lax \u2014 false positives here mean the engine thinks a submit succeeded when it didn't, and the candidate's application is lost.\n\nWhen verified=true, populate the three signal fields with what you found (any can be null if absent), and write a one-sentence rationale citing the strongest signal.\nWhen verified=false, write a one-sentence reason citing what you'd need to see to be convinced.";
/**
 * Site-supplied evidence and criteria for the submit-verifier. The engine
 * is fully site-agnostic; this object is built from the parsed flow file
 * and the in-flight cascade state.
 */
export interface VerifySubmitInput {
    pageUrl: string;
    pageTitle: string;
    unfocusedObserve: {
        description: string;
        selector: string;
    }[];
    networkCaptures: {
        method: string;
        status: number;
        url: string;
    }[];
    invalidMarkerCount: number;
    /** Per-site: hostnames that count as "the site's own backend." */
    ownBackendHostnames: string[];
    /** Per-site: URL fragments that indicate a successful submit. */
    successUrlFragments: string[];
    /** Per-site: page-title substrings that indicate a successful submit. */
    successPageTitleHints: string[];
    /** Per-site: DOM selectors that indicate the success page is rendered. */
    submittedStateSelectors: string[];
}
/**
 * Run the Haiku submit-verifier. Returns the parsed verdict (discriminated
 * union — `verified: true | false`). Returns null when the client is null
 * (Bedrock-only deployment, no Anthropic SDK) or when the API call fails —
 * callers fall back to the conservative "verified=false" default.
 */
export declare function verifySubmitWithLLM(params: {
    client: Anthropic | null;
    input: VerifySubmitInput;
    captureFn?: JudgeCaptureFn;
}): Promise<z.infer<typeof SUBMIT_VERDICT_SCHEMA> | null>;
export { SUBMIT_VERIFY_SYSTEM_PROMPT };
