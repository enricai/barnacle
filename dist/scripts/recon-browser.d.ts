/**
 * Phase 1 recon: drives a real browser through a user-defined flow while
 * wiretapping every network response. Captures are written to
 * /tmp/recon/graphql/<NNN>-<phase>-<operationName>.json — one file per call,
 * diffable and greppable.
 *
 * Recovery model — each flow step runs through a 4-attempt self-healing cascade
 * (act → observe+act → observe+act with ignoreSelectors → Anthropic-SDK rephrase),
 * verified by "did the network counter advance OR did the URL change". On terminal
 * cascade failure the step is dumped to /tmp/recon/step-failures/ and the script's
 * main() loop attempts up to MAX_REPLANS=2 global replans, where Claude rewrites
 * the remaining flow tail given the failure context. Bedrock-only deployments
 * skip the LLM-rephrase attempt and the replan loop with a startup warn. See
 * docs/playbook.md sections 1c–1e for the full design.
 *
 * Usage:
 *   pnpm tsx src/scripts/recon-browser.ts \
 *     --url https://example.com \
 *     --flow '["click the category filter", "open the first product"]'
 *
 *   # Or load the flow from a committed file (preferred — makes recon re-runnable):
 *   pnpm tsx src/scripts/recon-browser.ts \
 *     --url https://example.com \
 *     --flow-file src/sites/my-site/recon-flow.json
 *
 *   # Captures every network response — no URL-shape filtering. Use grep
 *   # against /tmp/recon/graphql/ if you only want specific endpoints.
 *   pnpm tsx src/scripts/recon-browser.ts --url https://example.com
 *
 * The script needs STEEL_API_KEY and either ANTHROPIC_API_KEY or USE_BEDROCK=true
 * in the environment (same vars as the main server).
 *
 * Runtime: varies — ~20–40 min for a full flow (STEP_PAUSE_MS × N steps + LLM latency
 * per act; healing and replans push the upper bound higher on flaky sites).
 */
import Anthropic from "@anthropic-ai/sdk";
import type { Action, Page, Stagehand } from "@browserbasehq/stagehand";
import { type LlmCallInput } from "../lib/telemetry/call-capture";
import type { Logger } from "../types/logging";
/**
 * Per-replan record kept so the end-of-run write-back can emit a summary
 * log block listing each replanned span. `failedInstruction` is the verbatim
 * instruction string that triggered the replan (probe-absent or cascade
 * exhausted), and `replanSteps` is the LLM-produced bridge that took its
 * place. The numeric `indexAtFailure` is the position in the in-memory plan
 * at the time of failure — meaningful for "step 12 of the plan failed" but
 * not directly mappable to the original flow.json once multiple replans
 * have rewritten the plan ahead of it.
 */
interface ReplanEvent {
    replanIndex: number;
    cause: "probe-absent" | "cascade-exhausted";
    indexAtFailure: number;
    failedInstruction: string;
    replanSteps: NormalizedStep[];
    timestamp: string;
    /**
     * Page state at the moment this replan was constructed. Used by
     * isReplanCycle to distinguish "same proposal under static page" (true
     * cycle) from "same proposal but page state advanced" (legitimate retry
     * under new conditions). Cheap signals: url equality + a permissive
     * htmlLength delta. See HTML_STATIC_TOLERANCE for the threshold rationale.
     */
    pageState: {
        url: string;
        htmlLength: number;
    };
}
/** Cheap snapshot of side effects we use to decide whether a step "worked". */
interface StepSnapshot {
    networkCount: number;
    url: string;
    /**
     * `document.body.outerHTML.length`. Measurement-only — pre/post delta
     * exposes whether a click triggered a client-side state change that
     * doesn't show up in network or URL (e.g. React view swap inside an SPA).
     * Not consumed by the verifier yet; gathered for threshold tuning.
     */
    bodyHtmlLength: number;
    /**
     * `document.body.innerText.length + ":" + first 200 chars`. A cheap,
     * deterministic proxy for "did the visible text change" that filters
     * React-internal attribute churn (which moves `bodyHtmlLength` without
     * moving anything the user perceives). Measurement-only.
     */
    visibleTextSignature: string;
}
/** One attempt's audit trail — included verbatim in the failure dump. */
interface AttemptRecord {
    attempt: number;
    technique: "act-string" | "observe-act" | "structured-click" | "observe-act-exclude" | "llm-rephrase";
    instruction: string | null;
    triedSelectors: string[];
    actResultSuccess: boolean | null;
    actResultDescription: string | null;
    errorMessage: string | null;
    pre: StepSnapshot;
    post: StepSnapshot;
    /**
     * Stagehand-resolved action method (`fill`, `click`, etc.) that the verifier
     * used to decide signal type. Null when no action was resolved (observe
     * returned no candidates) or when Stagehand returned an empty actions[].
     */
    resolvedMethod: string | null;
    /** Args Stagehand passed to the resolved action — what we expect to see post-fill. */
    resolvedArguments: string[] | null;
    /**
     * Which verification signal carried the attempt:
     * - `network`: same-origin POST counter advanced in the attempt window.
     * - `url`: page navigated to a new URL.
     * - `dom`: verifyDomEffect confirmed a structural change (radio/checkbox state).
     * - `submitted-state-dom`: final-step DOM fallback fired — a flow-declared
     *   `submittedStateSelectors` entry matched live DOM, indicating the SPA
     *   reached its submitted state even though the network capture missed
     *   the submit POST within the attempt window.
     * - `null`: failure path.
     */
    verifiedBy: "network" | "url" | "dom" | "submitted-state-dom" | null;
}
/**
 * Detect whether the supplied capture-meta window contains a backend
 * 5xx response that matches the configured submit endpoint pattern.
 * The cascade can't heal a backend crash by retrying clicks or
 * rephrasing instructions; surfacing this signal lets the caller
 * fail-fast instead of burning replan budget on an unrecoverable
 * server state.
 *
 * Conservative: requires both `submitEndpointPattern` to match (5xx
 * from analytics/tracking URLs is noise, not a real backend failure)
 * AND a 5xx status. Returns the matched URL when found; null otherwise.
 */
export declare function findRecentBackendError(params: {
    recentCaptureMeta: readonly {
        method: string;
        status: number;
        url: string;
    }[];
    preMetaLength: number;
    /**
     * Hostnames considered "the site's own backend." Replaces the prior
     * `submitEndpointPattern` regex — we no longer pattern-match URL paths,
     * just check hostname against the site-supplied whitelist (deterministic
     * string equality on a URL component, not a fuzzy regex). A 5xx from any
     * URL whose hostname is on this list is treated as a backend error;
     * 5xx from third-party hosts (analytics, CDNs) is ignored. Empty array
     * disables the check entirely.
     */
    ownBackendHostnames: readonly string[];
}): string | null;
/**
 * Detect whether the page legitimately transitioned within the supplied
 * capture-meta window — a 3xx redirect or a same-origin non-GET capture
 * that returned 2xx and looks like a flow-progression URL (not a tracking
 * beacon). `preMetaLength` is the caller's chosen window start (typically
 * captured at step entry, so the scan covers everything that landed since
 * this step began processing). When a transition is detected, a probe-
 * absent escalation to replan is unnecessary noise — the form auto-
 * advanced and the next probe naturally sees zero candidates for the OLD
 * step.
 *
 * Conservative: returns null when the signal is ambiguous so the cascade
 * keeps its existing replan path. Returns the matched URL string when a
 * transition is detected, which the caller logs as the reason for the
 * clean skip.
 */
export declare function findRecentPageTransition(params: {
    recentCaptureMeta: readonly {
        method: string;
        status: number;
        url: string;
    }[];
    preMetaLength: number;
}): string | null;
/**
 * Read-only count of ng-invalid form controls on the page. Side-effect-free
 * counterpart to `probeFormValidityBeforeSubmit` (which also auto-fills
 * unselected radio groups via element.click()). Used by the cascade's
 * early-exit predicate to detect "the Submit click revealed new required
 * questions" — when this count grows from 0 (pre-submit) to ≥1 (post-attempt-1),
 * attempts 2-5 cannot succeed and the cascade should route to replan
 * immediately instead of burning Stagehand calls.
 */
export declare function countNgInvalidContainers(page: Page): Promise<number>;
/**
 * Translate the pre/post snapshot delta + same-window captures into a short
 * diagnostic phrase that goes into `failureReasons[]`. Surfaces patterns the
 * verifier itself discards: e.g. "DOM grew but no submit-shaped network
 * request" (client-side validation blocked the form), or "analytics beacon
 * fired but no same-origin submit" (third-party tracking, not real signal).
 * The rephrase + replan LLMs read these strings to choose between "retry the
 * click" and "fill an unanswered required field".
 */
export declare function describeAttemptEffectSignals(pre: StepSnapshot, post: StepSnapshot, recentCaptureMeta: readonly {
    method: string;
    status: number;
    url: string;
}[], preMetaLength: number): string;
/**
 * Decide whether a cascade technique's preconditions cannot be met by the
 * prior attempts' state, so running it would burn the attempt slot without
 * exercising new behaviour. Conservative: returns true ONLY when the
 * predicate can prove the technique is mathematically unable to succeed;
 * anything ambiguous falls through to "run the attempt" so the cascade
 * keeps healing opportunistically.
 */
export declare function shouldSkipTechnique(params: {
    technique: "act-string" | "observe-act" | "structured-click" | "observe-act-exclude" | "llm-rephrase";
    priorAttempts: readonly {
        technique: string;
        triedSelectors: readonly string[];
        errorMessage: string | null;
    }[];
}): {
    skip: boolean;
    reason: string;
};
/**
 * Bucket the recent `recon-replan` LLM calls by `failureKind` and produce a
 * single diagnostic phrase the runner can surface when the cascade aborts
 * its replan budget. Lets the operator distinguish transient
 * (anthropic-rate-limit) from permanent (schema-validation-failed,
 * response-empty) failure modes without having to grep calls.ndjson.
 *
 * Reads the most recent N entries from the configured calls path, filters
 * to the matching callType, and tallies their failureKind. Empty string
 * when no relevant failures are present.
 */
export declare function summarizeReplanFailureKinds(params: {
    callsNdjsonPath: string;
    callType: string;
    tailCount?: number;
}): string;
/**
 * Detect a true replan cycle: the same multi-step instruction sequence
 * proposed REPLAN_CYCLE_THRESHOLD times in a row under page state that
 * hasn't materially advanced. The page-state guard (URL equality + bounded
 * htmlLength delta) is essential — a re-proposal under genuinely different
 * page state is a valid retry, not a cycle. Without the guard we'd block
 * legitimate "the page advanced; the same step now works" recoveries.
 */
export declare function isReplanCycle(priorReplans: readonly ReplanEvent[], newSteps: readonly NormalizedStep[], currentState: {
    url: string;
    htmlLength: number;
}): boolean;
/**
 * Decide whether attempt 1 on a final-Submit click revealed new required
 * questions that mathematically can't be cleared by retrying the same
 * click. When true, the cascade should break out of its attempt loop and
 * route directly to global replan, which already reads the failure dump's
 * ng-invalid + interactive-target lists and produces follow-up steps.
 *
 * Strict 5-condition predicate: the click must be on the final flow step
 * with a configured submit endpoint, the resolved action must be a click,
 * the pre/post snapshot delta must produce the dom-grew-without-network
 * signal, AND the ng-invalid container count must have grown. When any
 * condition fails, the full cascade runs as usual — keeping the predicate
 * from false-positiving on ordinary state changes (network-fired
 * navigations, partial DOM reflows, etc.).
 */
export declare function isSubmitRevealedInvalid(params: {
    isFinalStep: boolean;
    requireSubmitEndpoint: boolean;
    resolvedMethod: string | null;
    effectSignals: string;
    preSubmitInvalidCount: number;
    postAttemptInvalidCount: number;
}): boolean;
/** Injectable capture function — matches `captureLlmCall`'s signature. */
type CaptureFn = (input: LlmCallInput) => Promise<void>;
/**
 * Attempt-4 of the step-healing cascade: when three mechanical retry variations
 * all fail, this is the last resort before the step is declared terminal. Exported
 * so tests can inject a fake capture sink without touching the browser session.
 */
declare function rephraseWithLLM(client: Anthropic, originalStep: string, triedSelectors: string[], observeCandidates: Action[], failureReasons: string[], captureFn?: CaptureFn, 
/**
 * Optional live-page form evidence extracted by the caller (typically by
 * fetching document.body.outerHTML and running the Haiku invalid-fields
 * and error-messages judges on it). When non-empty, surfaces structurally
 * invalid form fields and visible error messages so the rephrase LLM can
 * propose corrective fills instead of
 * just "click harder" — the previous limitation observed in the
 * telemetry of the appcast Encompass run (every rephrase converged on
 * "Click Submit Application using JavaScript" because the prompt had no
 * signal that the form was invalid).
 */
pageEvidence?: {
    invalidFieldList: string;
    errorTextList: string;
    interactiveTargetsList: string;
}, 
/**
 * Optional unfocused observe list. The default `observeCandidates` is
 * Stagehand's observe filtered by the FAILED STEP'S INSTRUCTION — when
 * that step is "click submit," candidates collapse to "Submit button"
 * and any modals/dialogs blocking submit stay invisible to the LLM.
 * Pass an unfocused observe (stagehand.observe() with no instruction)
 * here so the rephrase prompt can see ambient UI like modal Save/Close
 * buttons that the failed step's instruction filter hid. Modal entries
 * are prioritized to the top by `renderUnfocusedObserve`.
 */
unfocusedObserve?: Action[], 
/**
 * Optional list of structured server-side validation errors harvested
 * from any failed submit-endpoint captures in the recent window. Lets
 * the rephrase LLM see "the form did POST and got back '{field: email,
 * message: Invalid format}' from the server" — a signal the verifier
 * alone hides behind "no observable effect".
 */
submitFailureList?: string, 
/**
 * Optional verbatim instructions sent by prior cascade attempts. The
 * SELECTORS ALREADY TRIED section tells the LLM which xpaths failed,
 * but not which natural-language strategies it (or earlier observe
 * branches) already proposed. Surfacing the prior instruction text
 * prevents the rephrase LLM from cycling on near-synonyms of a
 * wording the cascade has already proven ineffective.
 */
priorAttempts?: readonly {
    technique: string;
    instruction: string | null;
    verdict: string | null;
}[]): Promise<string | null>;
/**
 * Getter for the module-private billing-exhausted flag. Exported so the
 * cascade's attempt-5 guard can read it without coupling to module-level
 * state directly; also lets tests reset / observe the flag without
 * mutating shared globals.
 */
export declare function hasBillingErrorBeenLogged(): boolean;
/**
 * Test-only reset. Tests that exercise the billing-exhausted path need to
 * clear the per-process flag between cases; production code never resets it.
 */
export declare function resetBillingErrorFlagForTests(): void;
export declare function logBillingErrorIfPresent(err: unknown): boolean;
/**
 * Internal normalized step shape. Source-flow strings normalize with all flags
 * false. `origin` distinguishes hand-authored steps from steps the LLM
 * replanner appended at cascade-exhausted recovery points — persistReplannedFlow
 * uses it to force replan-origin steps to optional on write-back, preventing
 * cross-employer regressions when a Presbyterian-specific replanned question
 * gets persisted and the next run is on Encompass.
 */
interface NormalizedStep {
    instruction: string;
    optional: boolean;
    upload: boolean;
    origin: "original" | "replan";
}
/**
 * Inverse of normalizeFlow: maps an internal `NormalizedStep` back to the
 * on-disk union shape. Bare string for the common case (required,
 * non-upload); object with only the truthy flags otherwise. Round-trip is
 * lossless against `RECON_FLOW_SCHEMA` for any value the parser accepted.
 */
declare function denormalizeStep(step: NormalizedStep): string | {
    step: string;
    optional?: true;
    upload?: true;
};
/**
 * Collapse any consecutive run of structurally-identical denormalized
 * steps into a single entry. Used by `persistReplannedFlow` before write-
 * back so cumulative-replan noise (each cascade-exhausted replan adds the
 * same recovery bridge to the tail; after 5 replans the persisted file
 * carries 5 stacked copies) doesn't pollute the on-disk flow.
 *
 * Comparison is structural via JSON-stringify equality:
 * - Two strings with the same value collapse.
 * - Two objects with the same {step, optional, upload} collapse.
 * - A string and an object with the same instruction do NOT collapse — they
 *   are semantically different (bare = required, object = could be optional
 *   or upload).
 *
 * Only CONSECUTIVE duplicates collapse. A non-adjacent repeat is preserved
 * since flow authors sometimes intentionally re-fill a field after a
 * downstream interaction (e.g. re-fill First Name after the resume upload
 * triggers an Angular re-render). Adjacent duplicates are almost always
 * accumulation noise from successive replans converging on the same idea.
 */
declare function dedupeConsecutiveIdentical<T>(items: T[]): T[];
/**
 * Write-back at the end of a successful recon: back up the original file
 * bytes verbatim (so a subtle denormalization bug can never lose the user's
 * hand-authored flow), then write the in-memory plan back out and log a
 * summary of each replan event. No-op when `--no-save-replan` was passed or
 * when no replans fired.
 *
 * Backup path encodes the timestamp + .bak so accumulated backups are easy
 * to sort and prune. Uses synchronous writes — the recon is single-purpose
 * and we want the failure mode "write the bytes, then exit" rather than
 * "exit with the write half-flushed."
 */
declare function persistReplannedFlow(params: {
    flowFile: string;
    finalPlan: NormalizedStep[];
    replanEvents: ReplanEvent[];
    logger: Logger;
    /**
     * Preserves the user's on-disk shape — bare array stays bare array,
     * object form stays object form. Defaults to "array" for back-compat with
     * older callers (tests, internal scripts) that don't know about the
     * object form yet.
     */
    originalShape?: "array" | "object";
    /** Carried through when the original file declared a submit pattern. */
    submitEndpointPattern?: string | null;
    /** Carried through when the original file declared submitted-state DOM selectors. */
    submittedStateSelectors?: string[];
    /** Carried through when the original file opted into network-authoritative verification. */
    requireSubmitEndpointMatch?: boolean;
    /** Carried through when the original file declared success-URL fragments for the Haiku verifier. */
    successUrlFragments?: string[];
    /** Carried through when the original file declared success-page-title hints for the Haiku verifier. */
    successPageTitleHints?: string[];
    /** Carried through when the original file declared own-backend hostnames for the Haiku verifier. */
    ownBackendHostnames?: string[];
    /** Carried through when the original file declared known error-class prefixes for the Haiku judges. */
    knownErrorClassPrefixes?: string[];
}): void;
/**
 * Render an unfocused-observe array into a numbered string the prompt can
 * consume, prioritizing any modal/dialog/overlay/popup entries to the top
 * regardless of their index in the raw list. Without this prefix, modals
 * that Stagehand observes at index 70+ (verified against the prior run's
 * dump — 11 modal entries lived at positions 64-79 of 80) get truncated
 * away by the cap and the LLM-replan can't propose to save/close them.
 */
declare function renderUnfocusedObserve(observations: Action[], options?: {
    cap?: number;
    client?: Anthropic | null;
    captureFn?: CaptureFn;
}): Promise<string>;
/**
 * Live-page sibling to `readFailureDumpEvidence` — fetches the current
 * page body and runs the same framework-agnostic class scans. Used by the
 * cascade's per-attempt rephrase path, which fires BEFORE the failure dump
 * is written (the dump only happens after the whole cascade exhausts) and
 * therefore can't read from disk.
 *
 * Returns empty strings on any failure (page.evaluate threw, body missing,
 * etc.) — evidence is advisory, never load-bearing.
 */
/**
 * One paired "we filled this field and the validator visibly rejected it"
 * tuple. Surfaced to the LLM replan prompt as a structured failureReason
 * line so it can pivot the value or return outcome=impossible instead of
 * burning replan budget on the same proposal.
 */
export interface ValidationRejectionPair {
    fieldLabel: string;
    errorText: string;
}
/**
 * Pair invalid-marked field entries from invalidFieldList with their
 * positionally-adjacent error text from errorTextList. Strategy is
 * positional (not cross-product) — entry N pairs with entry N — because
 * the Haiku judges return fields and messages in DOM document order, so
 * the Nth invalid container's sibling error message tends to be the Nth
 * error entry.
 *
 * Returns an empty array when no entries match — pure additive signal,
 * silent no-op on sites whose forms don't follow this DOM convention.
 *
 * Why "touched+dirty" instead of just "invalid": empirical survey of
 * 30 production step-failure dumps showed 22 of 22 Continue/Submit
 * failures had the touched+dirty + visible error text pattern. The
 * remaining failure shapes (pristine empty required, fill-step
 * errors, pre-form failures) need different diagnostics.
 */
export declare function pairInvalidWithErrors(invalidFieldList: string, errorTextList: string): ValidationRejectionPair[];
/**
 * Format a {@link ValidationRejectionPair} as a single-line failureReason
 * string the LLM reads from the replan prompt's WHY VERIFICATION FAILED
 * block. Style matches existing reason formats (`submit-revealed-invalid`,
 * `submit-endpoint-not-matched`): leading category tag, then the facts,
 * then a brief imperative for what the LLM should do.
 */
export declare function formatValidationRejectedReason(pair: ValidationRejectionPair): string;
/**
 * Scan recent capture files for failed submit-endpoint requests and pull
 * out structured field-level errors from the response body. The cascade
 * already saves every captured request to `CAPTURES_DIR` with its parsed
 * `responseBody`; this helper reads those files back, filters to captures
 * matching the configured submit pattern with status >= 400, and walks
 * common error-shape conventions (`{ errors: [{ field, message }] }`,
 * `{ validation/fieldErrors: { … } }`, `{ message }`).
 *
 * Returns a short bullet list ready to drop into a prompt; empty string
 * when no failed submit was found. Advisory — never load-bearing.
 */
export declare function extractSubmitFailureEvidence(recentCaptureFilenames: readonly string[], 
/**
 * Hostnames considered "the site's own backend." In strict mode, only 4xx
 * responses from one of these hostnames count as submit failures (we
 * don't surface third-party CDN/analytics 4xx as form-rejection
 * evidence). Replaces the prior `submitEndpointPattern` regex with
 * deterministic hostname equality. Empty list / "any-4xx" mode disables
 * the host filter and returns any 4xx in the window.
 */
ownBackendHostnames: readonly string[], capturesDir?: string, mode?: "strict" | "any-4xx"): string;
declare function readFailureDumpEvidence(failureDumpPath: string, options?: {
    client?: Anthropic | null;
    knownErrorClassPrefixes?: readonly string[];
    captureFn?: CaptureFn;
}): Promise<{
    bodyExcerpt: string;
    unfocusedList: string;
    invalidFieldList: string;
    errorTextList: string;
    recentFailureReasons: string[];
}>;
/**
 * Global fallback after a step terminally fails all healing attempts: rewrites
 * only the un-run tail of the flow so already-verified steps are not disturbed.
 * Exported so tests can inject a fake capture sink without a live browser.
 */
declare function replanRemainingFlow(params: {
    client: Anthropic;
    originalFlow: string[];
    completedSteps: string[];
    failedStep: string;
    remainingSteps: string[];
    failureDumpPath: string;
    page: Page;
    stagehand: Stagehand;
    captureFn?: CaptureFn;
    /**
     * Files in `CAPTURES_DIR` recorded during the failed step's attempt
     * window. Used to surface structured server-side validation errors
     * to the replan LLM when a submit actually fired but was rejected.
     */
    recentCaptures?: readonly string[];
    /**
     * Hostnames considered "the site's own backend" — passed through to
     * extractSubmitFailureEvidence to filter which 4xx captures count as
     * form-rejection evidence vs third-party CDN/analytics noise. Replaces
     * the prior compiled submit-endpoint regex with deterministic hostname
     * equality on a structured URL component.
     */
    ownBackendHostnames?: readonly string[];
    /**
     * Site-supplied class-name prefixes that wrap error/invalid state markers.
     * Threaded into the readFailureDumpEvidence judge calls so the Haiku
     * invalid-fields and error-messages judges get site-specific hints.
     */
    knownErrorClassPrefixes?: readonly string[];
    /**
     * Optional short tail of prior steps' verification signals (network,
     * url, dom, submitted-state-dom). When provided, the prompt gets a
     * PRIOR STEP TRAJECTORY section so the LLM can distinguish "page has
     * been visibly transitioning (URL changes / submitted-state markers)"
     * from "page has been static (network signals + DOM-only updates)".
     * Helps the replanner avoid proposing regression steps when the form
     * has already advanced.
     */
    trajectory?: readonly {
        stepIndex: number;
        verifiedBy: AttemptRecord["verifiedBy"];
    }[];
    /**
     * Previous replans constructed for this run. Rendered into a PRIOR REPLAN
     * HISTORY section as graduated discouragement — re-proposing a sequence
     * that already failed is unlikely to converge, but is not forbidden because
     * intervening cascade steps may have advanced the page since the prior
     * attempt. The deterministic isReplanCycle predicate is the safety net.
     */
    priorReplans?: readonly ReplanEvent[];
}): Promise<NormalizedStep[] | null>;
/**
 * Runs one flow step through the self-healing cascade. Returns when any
 * attempt produces an observable effect (network call or URL change). Throws
 * StepVerificationError after all attempts have been exhausted; the
 * diagnostic bundle on disk has everything the human needs to fix the flow.
 */
/**
 * Cheap page-state check run BEFORE the self-healing cascade. Asks Stagehand
 * to observe the page filtered by the step's instruction; returns "absent"
 * when zero candidates come back. Treat any thrown error (incl. timeout) as
 * "present" — we don't want a flaky observe call to short-circuit into a
 * replan when the cascade might still succeed; the cascade has its own
 * timeouts and dump path.
 *
 * The cascade does this same call as attempt 2 today (line ~1278). Running
 * it ahead of attempt 1 catches the failure mode confirmed by step-failures
 * dumps 008 + 086: page state had drifted (e.g. flow expected the form page
 * but the SPA was still on the resume-upload screen), so attempt 1's
 * `stagehand.act(step)` chewed up an LLM call producing nothing useful. The
 * probe lets us fail fast and feed the replanner a clean "no candidates"
 * signal instead of "all 4 attempts failed."
 */
/** One entry per ng-invalid form control found by the pre-submit probe. */
interface InvalidFormControl {
    /** Human-readable label associated with the field — element's nearest
     * `<label>` text, or the value of `aria-label` / `data-id` / `name`. */
    label: string;
    /** Compact class signature naming the framework-specific marker that
     * matched, e.g. `ng-invalid ng-touched`. Helps the LLM correlate
     * "user-interacted + still invalid" patterns. */
    classSignature: string;
    /** True when the underlying control is *empty* (text input value is "",
     * radio/checkbox is unchecked, select has no chosen option). False
     * means the field is non-empty but still marked invalid (e.g. wrong
     * format). The cascade's pre-submit warning surfaces the empty ones
     * loudly because they are almost always Stagehand re-render victims. */
    emptyOrUnchecked: boolean;
    /** Set by the probe when it auto-picked a value to clear the
     * ng-invalid state. Identifies WHAT action was taken so the cascade
     * can surface a self-heal hint ("the probe auto-picked X for you;
     * consider adding an explicit step to the flow file"). `null` when no
     * auto-pick fired (either the control was already valid, or the probe
     * couldn't find a sensible default). */
    autoFilled: {
        action: "selected-radio" | "checked-checkbox" | "filled-text" | "selected-option";
        value: string;
    } | null;
}
/**
 * Runs ONLY on the cascade's final step when a submitEndpointPattern is
 * declared. Surfaces ng-invalid form controls (and whether each is empty)
 * BEFORE the first click attempt, so the cascade's first failure reason
 * names the real blocker instead of "no observable effect." Empty + invalid
 * is the signature of "Stagehand filled this earlier but a downstream
 * Angular/React re-render wiped it" — the issue the LLM-replan cannot
 * diagnose from observe-list alone.
 *
 * Returns the list (potentially empty) so callers can both log it AND
 * inject structured warnings into the cascade's failureReasons array.
 * Pure read — no side effects on the page.
 */
/**
 * Type-narrow a raw page.evaluate payload entry into a typed
 * `InvalidFormControl`. Exported for unit testing — the browser-context
 * expression is hard to unit-test directly, but the narrowing happens on
 * the Node side and is the source of any bugs that would silently coerce
 * a malformed entry into a valid record.
 *
 * Returns null when the entry is missing required fields or has the wrong
 * shape. Defensive about `autoFilled` (allowed to be null OR a typed
 * action+value object; anything else becomes null).
 */
declare function narrowInvalidFormControl(entry: unknown): InvalidFormControl | null;
export type { InvalidFormControl, NormalizedStep, ReplanEvent };
export { dedupeConsecutiveIdentical, denormalizeStep, narrowInvalidFormControl, persistReplannedFlow, readFailureDumpEvidence, renderUnfocusedObserve, rephraseWithLLM, replanRemainingFlow, };
