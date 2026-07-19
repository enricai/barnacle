/**
 * Self-heal step-execution engine for Phase 1 recon. Extracted verbatim from
 * `recon-browser.ts` so the step runner, its five DOM primitives (upload,
 * select, checkbox, radio, required-selects), the pure verify/signal helpers,
 * and the in-memory network-capture wiring can be reused and unit-tested apart
 * from the recon CLI entry-point. This module is a leaf: it never imports the
 * recon CLI module, so the CLI can depend on it without a cycle.
 *
 * Two seams let the CLI inject its disk-facing behavior without this module
 * knowing about the filesystem layout: {@link wireSignalCapture} takes an
 * `onCapture` callback for persisting each capture, and
 * {@link executeStepWithHealing} takes an `onStepFailure` callback for writing
 * the terminal failure dump.
 */

import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { Action, Page, Stagehand } from "@browserbasehq/stagehand";

import { config } from "@/config";
import { toErrorMessage } from "@/lib/errors";
import type { JudgeCaptureFn } from "@/lib/llm/judge";
import { judgeErrorMessagesWithLLM } from "@/lib/llm/judges/error-messages";
import { judgeInvalidFieldsWithLLM } from "@/lib/llm/judges/invalid-fields";
import { judgeModalPriorityWithLLM } from "@/lib/llm/judges/modal-priority";
import { judgeSelectOptionWithLLM } from "@/lib/llm/judges/select-option";
import { verifySubmitWithLLM } from "@/lib/llm/judges/verify-submit";
import { REPHRASE_RESPONSE_SCHEMA } from "@/lib/llm/schemas";
import { getLogger } from "@/lib/logging";
import {
  captureLlmCall,
  classifyLlmCallFailure,
  type LlmCallInput,
} from "@/lib/telemetry/call-capture";
import { CALL_TYPE_RECON_REPHRASE } from "@/lib/telemetry/call-types";
import { StepVerificationError } from "@/scraper/errors";
import { classifyPhantomClick, type PhantomClickVerdict } from "@/scraper/phantom-click";
import { guardedAct, guardedObserve } from "@/scraper/stagehand-guard";
import {
  buildClickByDeepIndexExpr,
  buildRankSubmitCandidatesExpr,
  type SubmitCandidate,
} from "@/scraper/submit-control";
import { type Capture, resolveReconRunDir } from "@/scripts/recon-shared";
import type { Logger } from "@/types/logging";

const logger = getLogger({ name: "scraper/flow-runner" });

/** Cap on the rolling capture-filename window held in memory for failure dumps. */
const RECENT_CAPTURES_WINDOW = 20;

/**
 * Folds a request's `Network.responseReceivedExtraInfo` headers over its
 * `responseReceived` headers. Exists because CDP splits response headers across
 * two events: `responseReceived` omits `Set-Cookie` (so a token-minting call's
 * cookie is invisible to it), while `responseReceivedExtraInfo` carries the raw
 * on-the-wire set. `extra`'s keys override `base`'s on an exact-key match;
 * headers that differ only in case survive as separate entries — harmless here
 * because the one extra-only header we depend on (`Set-Cookie`) has no
 * `responseReceived` counterpart to collide with, and consumers read headers
 * case-insensitively.
 */
export function mergeResponseHeaders(
  base: Record<string, string>,
  extra: Record<string, string> | undefined
): Record<string, string> {
  if (!extra) return base;
  return { ...base, ...extra };
}

/**
 * Wires CDP Network event listeners onto the page's main session and returns
 * a cleanup function. Stagehand V3 already enables the Network domain
 * internally, so we only need to attach our own listeners.
 *
 * Uses `requestId` to correlate requestWillBeSent/responseReceived/loadingFinished
 * so we can fetch the response body only after it's fully received.
 *
 * Owns only the in-memory half of capture handling: builds each {@link Capture},
 * records it in the rolling `recentCaptures`/`recentCaptureMeta` windows, and
 * emits the analytics early-warnings. Persistence is delegated to the optional
 * `onCapture` callback so the recon CLI can own the disk layout without this
 * leaf module depending on it.
 */
export function wireSignalCapture(
  page: Page,
  params: {
    counter: { n: number };
    signalCounter: { n: number };
    recentCaptures: string[];
    recentCaptureMeta: { method: string; status: number; url: string }[];
    getCurrentPhase: () => string;
    getCurrentPageOrigin: () => string;
    onCapture?: (capture: Capture, filename: string) => void;
  }
): () => void {
  const {
    counter,
    signalCounter,
    recentCaptures,
    recentCaptureMeta,
    getCurrentPhase,
    getCurrentPageOrigin,
    onCapture,
  } = params;
  const session = page.getSessionForFrame(page.mainFrameId());
  const inFlight = new Map<string, InFlightRequest>();
  // Set-Cookie (and other extra-info-only headers) keyed by requestId. Held
  // separately because `responseReceivedExtraInfo` can fire before the request
  // is in `inFlight` and more than once per request; accumulated here and folded
  // into the capture once, in `onFinished` (the only place a Capture is built).
  // See mergeResponseHeaders.
  const extraResponseHeaders = new Map<string, Record<string, string>>();
  // Cookie (and other extra-info-only request headers) keyed by requestId.
  // Mirrors extraResponseHeaders: Network.requestWillBeSent omits the outgoing
  // Cookie header by design, and requestWillBeSentExtraInfo — which carries it —
  // can race requestWillBeSent in either order. Buffered here and folded into
  // the capture once, in `onFinished`. See mergeResponseHeaders.
  const extraRequestHeaders = new Map<string, Record<string, string>>();
  // One-shot per-run warning state for the GA `ep.isExpired=true` beacon.
  // Defensive instrumentation: across 5,542 captures surveyed 2026-06-15,
  // every observation was `false` — but if a future job ever ships in the
  // "expired" state, the cascade should surface it loudly rather than burn
  // a full run trying to submit against a closed application. Stays
  // site-agnostic: any GA4-instrumented site that publishes the same
  // `ep.isExpired` event parameter benefits without engine changes.
  let isExpiredWarned = false;

  type RequestWillBeSentEvent = {
    requestId: string;
    request: { url: string; method: string; headers: Record<string, string>; postData?: string };
  };
  type ResponseReceivedEvent = {
    requestId: string;
    response: { status: number; headers: Record<string, string> };
  };
  type ResponseReceivedExtraInfoEvent = {
    requestId: string;
    headers: Record<string, string>;
  };
  type RequestWillBeSentExtraInfoEvent = {
    requestId: string;
    headers: Record<string, string>;
  };
  type LoadingFinishedEvent = { requestId: string };
  type GetResponseBodyResponse = { body: string; base64Encoded: boolean };

  const onRequest = (params: RequestWillBeSentEvent): void => {
    inFlight.set(params.requestId, {
      url: params.request.url,
      method: params.request.method,
      requestHeaders: params.request.headers as Record<string, string>,
      requestPostData: params.request.postData ?? null,
      responseStatus: 0,
      responseHeaders: {},
    });
  };

  const onResponse = (params: ResponseReceivedEvent): void => {
    const req = inFlight.get(params.requestId);
    if (!req) return;
    req.responseStatus = params.response.status;
    req.responseHeaders = params.response.headers as Record<string, string>;
  };

  const onResponseExtraInfo = (params: ResponseReceivedExtraInfoEvent): void => {
    // Accumulate — a redirect fires this more than once per requestId. The fold
    // into the capture happens once, in onFinished, so order with responseReceived
    // never matters.
    const merged = mergeResponseHeaders(
      extraResponseHeaders.get(params.requestId) ?? {},
      params.headers
    );
    extraResponseHeaders.set(params.requestId, merged);
  };

  const onRequestExtraInfo = (params: RequestWillBeSentExtraInfoEvent): void => {
    // Accumulate — can race requestWillBeSent in either order, and a redirect
    // fires this more than once per requestId. The fold into the capture
    // happens once, in onFinished, so order with requestWillBeSent never matters.
    const merged = mergeResponseHeaders(
      extraRequestHeaders.get(params.requestId) ?? {},
      params.headers
    );
    extraRequestHeaders.set(params.requestId, merged);
  };

  const onFinished = async (params: LoadingFinishedEvent): Promise<void> => {
    const req = inFlight.get(params.requestId);
    if (!req) return;
    inFlight.delete(params.requestId);
    // Fold the accumulated extra-info headers in, once, regardless of the order
    // they raced responseReceived in. Delete the buffer entry unconditionally so
    // it can't leak per run.
    req.responseHeaders = mergeResponseHeaders(
      req.responseHeaders,
      extraResponseHeaders.get(params.requestId)
    );
    extraResponseHeaders.delete(params.requestId);
    // Same fold, request side: recovers the outgoing Cookie header that
    // requestWillBeSent omits by design.
    req.requestHeaders = mergeResponseHeaders(
      req.requestHeaders,
      extraRequestHeaders.get(params.requestId)
    );
    extraRequestHeaders.delete(params.requestId);

    const phase = getCurrentPhase();
    let responseBody: unknown = null;
    try {
      const result = await page.sendCDP<GetResponseBodyResponse>("Network.getResponseBody", {
        requestId: params.requestId,
      });
      const text = result.base64Encoded
        ? Buffer.from(result.body, "base64").toString("utf8")
        : result.body;
      try {
        responseBody = JSON.parse(text);
      } catch {
        responseBody = text;
      }
    } catch {
      // binary or body unavailable
    }

    let operationName: string | null = null;
    let query: string | null = null;
    let variables: unknown = null;
    let decodedParams: unknown = null;

    if (req.requestPostData) {
      decodedParams = tryDecode(req.requestPostData);
      const parsed =
        typeof decodedParams === "object" && decodedParams !== null
          ? (decodedParams as Record<string, unknown>)
          : null;
      if (parsed) {
        operationName = (parsed.operationName as string) ?? null;
        query = (parsed.query as string) ?? null;
        variables = parsed.variables ?? null;
      }
    }

    const idx = String(counter.n++).padStart(3, "0");
    // The verifier reads `signalCounter` (not `counter`) so background polls
    // and page-load chrome don't poison the "did this action cause something"
    // signal. We approximate "action-driven" with two closed-set
    // discriminators:
    //   1. Non-GET method (real form submits/uploads/state-changes are
    //      POST/PUT/PATCH/DELETE; GETs are page-load chrome and polls).
    //   2. Same-origin as the page. Cross-origin POSTs are tracking-pixel
    //      beacons (analytics, ad networks, bot-protection telemetry) that
    //      fire on any click. Counting them poisons the verifier: a
    //      submit-button click that fired only telemetry would be
    //      indistinguishable from one that fired the real submit XHR, and
    //      the cascade would silently declare victory while no actual
    //      submission happened.
    //
    // The method discriminator replaces a prior URL-shape regex
    // (POLLING_URL_PATTERNS) that misclassified jQuery-cache-busted
    // page-load GETs as polls. See feedback_no_regex_open_sets — URL
    // classification is an open-set problem; HTTP method and origin
    // are closed-set discriminators.
    //
    // Filename indexing stays on `counter` so polls and cross-origin
    // captures still get unique filenames on disk.
    let sameOrigin = false;
    try {
      sameOrigin = new URL(req.url).origin === getCurrentPageOrigin();
    } catch {
      // Opaque CDP URLs (data:, blob:, malformed) — treat as not same-origin.
    }
    if (req.method !== "GET" && sameOrigin) {
      signalCounter.n++;
    }
    // Capture filename uses <counter>-<phase>-<unix-ms>-<short-hash> to
    // guarantee bounded length regardless of URL shape. Previously we used
    // the URL's path tail verbatim, which crashed the run with ENAMETOOLONG
    // on data:image/svg+xml;base64,... URLs (~2000+ char base64 payloads).
    // The hash is SHA-1 over the request URL truncated to 8 hex chars —
    // collision-resistant within the bounded set of captures per run, and
    // the URL itself is durably recoverable from `capture.url` in the JSON
    // body for forensics.
    const urlHash = createHash("sha1").update(req.url, "utf8").digest("hex").slice(0, 8);
    const filename = `${idx}-${phase}-${Date.now()}-${urlHash}.json`;

    const capture: Capture = {
      timestamp: new Date().toISOString(),
      phase,
      method: req.method,
      url: req.url,
      status: req.responseStatus,
      requestHeaders: req.requestHeaders,
      requestPostData: req.requestPostData,
      responseHeaders: req.responseHeaders,
      responseBody,
      operationName,
      query,
      variables,
      decodedParams,
    };

    // Record every capture in the rolling filename window BEFORE handing off to
    // the persistence sink, unconditionally: the failure-dump window must reflect
    // what actually traversed the network even if the sink (disk write) later
    // fails. Persistence is the CLI's concern, delegated via `onCapture`.
    recentCaptures.push(filename);
    if (recentCaptures.length > RECENT_CAPTURES_WINDOW) {
      recentCaptures.splice(0, recentCaptures.length - RECENT_CAPTURES_WINDOW);
    }
    onCapture?.(capture, filename);
    // GA `ep.isExpired=true` early-warning: when the site's own analytics
    // says the job is expired, attempting to submit is dead work. Emit a
    // loud one-shot warning so the run summary surfaces this state instead
    // of letting the cascade burn budget on an unsolvable form. URL-only
    // scan (no body parse) keeps the cost bounded; the parameter is a top-
    // level URL param on `*google-analytics.com/g/collect` beacons.
    if (!isExpiredWarned && /[?&]ep\.isExpired=true(?:&|$)/.test(capture.url)) {
      isExpiredWarned = true;
      logger.warn(
        `EXPIRED_JOB_DETECTED: site analytics reported ep.isExpired=true on ${capture.url.slice(0, 120)} — the job posting has expired; submit attempts will likely fail or be rejected silently. Verify the resolved URL is still active before continuing this run.`
      );
    }
    // GETs are static asset chunks, polls, and idle prefetches; cross-origin
    // captures are tracking-pixel beacons. Neither is a user-action signal.
    // Filter both at the source so Tier 1's mutation window (size
    // RECENT_CAPTURES_WINDOW) doesn't get washed out by SPA chunk loads or GA
    // pings between meaningful mutations. Same discriminator signalCounter
    // uses for the per-step verifier.
    if (capture.method !== "GET" && sameOrigin) {
      recentCaptureMeta.push({
        method: capture.method,
        status: capture.status,
        url: capture.url,
      });
      if (recentCaptureMeta.length > RECENT_CAPTURES_WINDOW) {
        recentCaptureMeta.splice(0, recentCaptureMeta.length - RECENT_CAPTURES_WINDOW);
      }
    }

    logger.info(`captured [${capture.status}] ${capture.method} ${req.url} → ${filename}`);
  };

  session.on("Network.requestWillBeSent", onRequest);
  session.on("Network.requestWillBeSentExtraInfo", onRequestExtraInfo);
  session.on("Network.responseReceived", onResponse);
  session.on("Network.responseReceivedExtraInfo", onResponseExtraInfo);
  session.on("Network.loadingFinished", onFinished);

  return (): void => {
    session.off("Network.requestWillBeSent", onRequest);
    session.off("Network.requestWillBeSentExtraInfo", onRequestExtraInfo);
    session.off("Network.responseReceived", onResponse);
    session.off("Network.responseReceivedExtraInfo", onResponseExtraInfo);
    session.off("Network.loadingFinished", onFinished);
  };
}

/** Navigation timeout for page.goto — raise for slow tunnels or proxied targets. */
export const GOTO_TIMEOUT_MS = 120_000;
/** Post-action pause between flow steps — gives the page time to settle. */
const STEP_PAUSE_MS = 2_000;
/**
 * Settle window after committing a radio before re-reading its validity. MUI's
 * controlled-form validation re-flags `required` a beat AFTER the value change,
 * so an immediate readback sees stale pre-validation state (the fs4 "18 years"
 * bug: `checked=1` + `Mui-error` at once). One tick (~400ms) lets the async
 * re-validation land; far below `STEP_PAUSE_MS` so it barely affects run time.
 */
const RADIO_SETTLE_MS = 400;
/**
 * Same async-revalidation tick as {@link RADIO_SETTLE_MS}, for native `<select>`
 * commits. After a synthetic value-set on a MUI `NativeSelect`, the wrapping
 * FormControl re-runs its required-validation a beat later; reading `aria-invalid`
 * immediately sees stale (pre-validation) state. Waiting one tick lets the
 * `Mui-error`/`aria-invalid` marker settle so the primitive can HONESTLY report
 * whether the value committed (cleared the required flag) vs merely set the DOM
 * value that a later worklet re-render will wipe.
 */
const SELECT_SETTLE_MS = 400;
/**
 * Extra bounded poll window for a network-only advance whose real
 * `TransitionWorklet(type="next")` POST lands AFTER the `STEP_PAUSE_MS`
 * snapshot. HCA/Talemetry's "Next" click fires a fast `WorkletPayload` autosave
 * first, then the actual transition ~0.6-2s+ later — so a one-shot check
 * false-negatives the advance, retries the click, and the stale retry fires a
 * `back` that bounces the wizard. Additive to `STEP_PAUSE_MS`; only spent on an
 * advance-only-network step whose transition body hasn't landed yet.
 */
const ADVANCE_TRANSITION_POLL_MS = 4_000;
/** Poll interval for {@link ADVANCE_TRANSITION_POLL_MS}. */
const ADVANCE_TRANSITION_POLL_INTERVAL_MS = 350;

/**
 * Attempts to decode opaque request parameters: tries JSON parse, then
 * URL-decode, then base64. Returns the decoded value or null if none worked.
 */
function tryDecode(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    // not JSON
  }
  try {
    const decoded = decodeURIComponent(value);
    if (decoded !== value) return decoded;
  } catch {
    // not URL-encoded
  }
  try {
    const b64 = Buffer.from(value, "base64").toString("utf8");
    if (/[\x20-\x7e]/.test(b64)) return b64;
  } catch {
    // not base64
  }
  return null;
}

type InFlightRequest = {
  url: string;
  method: string;
  requestHeaders: Record<string, string>;
  requestPostData: string | null;
  responseStatus: number;
  responseHeaders: Record<string, string>;
};

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

/** Max attempts inside the self-healing cascade for a single flow step. */
const MAX_STEP_ATTEMPTS = 5;
/** Per-attempt linear backoff base; sleep = attempt * BACKOFF_MS. */
const ATTEMPT_BACKOFF_MS = 1_000;
/**
 * Per-step watchdog passed as Stagehand's native `timeout` on every
 * `act()`/`observe()`. Stagehand's `ensureTimeRemaining()` checks the
 * deadline between work units and throws `ActTimeoutError` cleanly on
 * expiry — the healing cascade catches it as just another attempt failure.
 * Matches `GOTO_TIMEOUT_MS` precedent so a hung Stagehand call can't pin
 * the recon for hours.
 */
export const STEP_WATCHDOG_MS = 120_000;
/**
 * Replans triggered by the pre-step page-state probe (cheap: ~1 observe +
 * 1 LLM call). Spent when the probe sees zero candidates for a required
 * step's instruction, indicating the page state has drifted from what the
 * flow expects (e.g. previous step advanced past where the flow expected).
 */

/**
 * Framework-agnostic invalid/required-unfilled marker source, shared across
 * every DOM invalid-detection path so they stay uniform. Exported as a raw
 * pattern string (not a RegExp) because most consumers interpolate it into a
 * browser-context `page.evaluate` expression string, where a Node RegExp can't
 * cross the boundary.
 *
 * Why the additions beyond the original Angular/Bootstrap set: HCA's Talemetry
 * wizard mixes Angular pages AND Material-UI (React) pages (Review, self-ID,
 * COMPENSATION). MUI marks invalid controls with `Mui-error` (class) +
 * `aria-invalid="true"` (attribute), NONE of which the ng-only regex matched —
 * so the engine was structurally blind to MUI required-field validation and
 * silently advanced past unfilled MUI forms. Confirmed on real captures: a
 * Review dump had 0 ng-invalid but 18 `Mui-error` + 12 `aria-invalid`.
 */
const INVALID_MARKER_CLASS_SOURCE =
  "ng-invalid|mat-form-field-invalid|is-invalid|field-invalid|input-invalid|form-invalid|Mui-error";
/**
 * Browser-context predicate string: given an element `el` in scope, is it a
 * required-unfilled / invalid control? Covers the class markers above AND the
 * MUI/React attribute signature (`aria-invalid="true"`, or a required control
 * still empty). Interpolate into a `page.evaluate` expr where `el` is bound.
 * Kept as an IIFE-free expression so it composes inside larger exprs.
 */
const INVALID_MARKER_EL_EXPR = `((el) => {
  const rx = /(${INVALID_MARKER_CLASS_SOURCE})/;
  const cls = (el.getAttribute && el.getAttribute("class")) || "";
  if (rx.test(cls)) return true;
  if (el.getAttribute && el.getAttribute("aria-invalid") === "true") return true;
  return false;
})`;
/**
 * How many steps from the end of the flow are considered "trailing" for the
 * Tier 1 grace path. A verification failure on an optional step within this
 * window is treated as a benign no-op exit when a recent non-GET capture also
 * returned 2xx — the flow's real work landed and the trailing tail is
 * redundant. Two covers the common pattern: an upload step followed by a
 * final Continue/Submit click.
 */
export const TRAILING_GRACE_WINDOW = 2;

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
export interface AttemptRecord {
  attempt: number;
  technique:
    | "act-string"
    | "observe-act"
    | "structured-click"
    | "observe-act-exclude"
    | "deep-submit-locator"
    | "llm-rephrase";
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
  /**
   * {@link classifyPhantomClick}'s verdict for this attempt, computed from
   * the same pre/post snapshot pair `describeAttemptEffectSignals` already
   * renders — `null` until the no-observable-effect branch runs (verified
   * attempts never reach it). `"phantom"` (Stagehand claimed success but
   * nothing observably happened) is what escalates the next attempt to
   * `deep-submit-locator` instead of repeating a light-DOM technique.
   */
  phantomClickVerdict: PhantomClickVerdict | null;
}

/**
 * Trust boundary: static string literal, fixed at compile time. No interpolation
 * means no injection surface. Runs in browser context and returns a typed-narrow
 * shape via Runtime.callFunctionOn.
 */
const DOM_SNAPSHOT_EXPR = `(() => { const b = document.body; if (!b) return { html: 0, text: "" }; const t = b.innerText || ""; return { html: (b.outerHTML || "").length, text: t.length + ":" + t.slice(0, 200) }; })()`;

export async function snapshotPage(
  page: Page,
  signalCounter: { n: number }
): Promise<StepSnapshot> {
  let bodyHtmlLength = 0;
  let visibleTextSignature = "";
  try {
    const result = await page.evaluate(DOM_SNAPSHOT_EXPR);
    if (
      result !== null &&
      typeof result === "object" &&
      "html" in result &&
      "text" in result &&
      typeof (result as { html: unknown }).html === "number" &&
      typeof (result as { text: unknown }).text === "string"
    ) {
      bodyHtmlLength = (result as { html: number }).html;
      visibleTextSignature = (result as { text: string }).text;
    }
  } catch {
    // Snapshot is observational; on failure, defaults to 0/"" so the verifier
    // sees no delta. Real state-class checks already cover the verified path.
  }
  return {
    networkCount: signalCounter.n,
    url: page.url(),
    bodyHtmlLength,
    visibleTextSignature,
  };
}

/**
 * Detect whether a 2xx response body indicates the server REJECTED the
 * application despite returning a 2xx HTTP status. Many ATSs use a "200 OK
 * with rejection envelope" pattern instead of a 4xx: AppCast returns
 * `{not_qualified: true, error: "Not qualified reason: <field>"}`,
 * Greenhouse uses `{rejected: true, reason: "..."}`, Lever uses
 * `{qualified: false, reason: "..."}`, Workday uses
 * `{status: "rejected"}`. Empirically verified on AppCast: 4/6 historical
 * /integrated_apply 200s on this codebase had `not_qualified: true` and
 * we treated them as wins because the audit only checked HTTP status.
 *
 * Site-agnostic: the helper checks for the union of common rejection
 * envelope shapes. New ATSs can be added by extending the recognized
 * keys; the existing ones cover the four most common patterns.
 */

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
export function findRecentBackendError(params: {
  recentCaptureMeta: readonly { method: string; status: number; url: string }[];
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
}): string | null {
  const { recentCaptureMeta, preMetaLength, ownBackendHostnames } = params;
  if (ownBackendHostnames.length === 0) return null;
  const window = recentCaptureMeta.slice(preMetaLength);
  for (const m of window) {
    if (m.status < 500 || m.status >= 600) continue;
    let hostname: string;
    try {
      hostname = new URL(m.url).hostname;
    } catch {
      continue;
    }
    if (!ownBackendHostnames.includes(hostname)) continue;
    return m.url;
  }
  return null;
}

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
export function findRecentPageTransition(params: {
  recentCaptureMeta: readonly { method: string; status: number; url: string }[];
  preMetaLength: number;
}): string | null {
  const { recentCaptureMeta, preMetaLength } = params;
  const window = recentCaptureMeta.slice(preMetaLength);
  if (window.length === 0) return null;
  for (const m of window) {
    if (m.status >= 300 && m.status < 400) return m.url;
  }
  for (const m of window) {
    if (m.method === "GET") continue;
    if (m.status < 200 || m.status >= 300) continue;
    if (/(googleads|doubleclick|gtm\.js|analytics|pixel|airbrake|sentry|rmkt)/i.test(m.url))
      continue;
    return m.url;
  }
  return null;
}

/**
 * Wizard-exit action labels: controls that ABANDON / restart a multi-page
 * wizard rather than advance it. When a flow's "advance / click Next" step
 * resolves the LLM's `act` onto one of these, acting on it can save-and-exit,
 * cancel, or restart the application — silently sending the run backward. The
 * cascade rejects a resolved action whose description matches one of these so
 * an advance step never fires a destructive control. Deliberately narrow: only
 * unambiguously-destructive labels, NEVER bare "continue"/"next"/"apply"/
 * "accept" (those are legitimate advance controls on many ATSes).
 */
const WIZARD_EXIT_ACTION_LABELS: readonly string[] = [
  "continue later",
  "save & exit",
  "save and exit",
  "save for later",
  "cancel application",
  "cancel and exit",
  "start over",
  "delete application",
  "discard",
];

/**
 * True when a resolved action's description names a wizard-exit control (a
 * save-and-exit / cancel / restart button) rather than a forward action.
 * Matched case-insensitively as a substring against the built-in list plus any
 * site-supplied `extraLabels`. Bare "cancel"/"back" are intentionally NOT in the
 * default list (too many false positives, e.g. "cancel changes to this field",
 * "background"); a site can add them via `wizardExitButtonLabels` if its wizard
 * uses them destructively.
 */
export function isWizardExitAction(
  description: string | null | undefined,
  extraLabels: readonly string[] = []
): boolean {
  if (!description) return false;
  const haystack = description.toLowerCase();
  for (const label of [...WIZARD_EXIT_ACTION_LABELS, ...extraLabels]) {
    if (haystack.includes(label.toLowerCase())) return true;
  }
  return false;
}

/**
 * Phrases (in the ORIGINAL flow instruction) that mark a step whose intent is to
 * ADVANCE the wizard to the next page — a "Next"/"Continue" click — as opposed
 * to a field-answer step (fill / select / click a radio). Matched against the
 * step text, not a resolved element description.
 */
const ADVANCE_STEP_PHRASES: readonly string[] = [
  "'next' button",
  "next button",
  "click the next",
  "click 'next'",
  "continue to the next",
  "proceed to the next",
  "advance to the next",
];

/**
 * Is this flow step an advance/"Next" click (move to the next wizard page),
 * rather than a field-answer? Used to veto a DOM-only "success" (a field toggle)
 * from counting as an advance: toggling a control never moves the wizard, so an
 * advance step must be verified by a real transition (network/URL), not a DOM
 * state change. Keyed on the ORIGINAL step instruction so a rephrase that
 * resolves "Next" to a radio click can't launder a field toggle into a passed
 * advance. Pure; unit-testable seam mirroring `isWizardExitAction`.
 */
export function isAdvanceStep(instruction: string | null | undefined): boolean {
  if (!instruction) return false;
  const haystack = instruction.toLowerCase();
  return ADVANCE_STEP_PHRASES.some((p) => haystack.includes(p));
}

/**
 * Parse the monotonic capture index from a capture filename. Every capture is
 * written as `<idx>-<phase>-<unix-ms>-<hash>.json` where `<idx>` is a
 * zero-padded, never-reused counter (`counter.n++`). Returns the numeric prefix,
 * or null when the name has no leading integer. Pure; the seam the window
 * helpers use to scope a step's captures by INDEX rather than by array position.
 */
export function parseCaptureIndex(filename: string): number | null {
  const m = /^(\d+)-/.exec(filename);
  const digits = m?.[1];
  if (digits === undefined) return null;
  const n = Number.parseInt(digits, 10);
  return Number.isNaN(n) ? null : n;
}

/**
 * The highest capture index currently known, read from the LIVE `recentCaptures`
 * array's last entry (captures are appended in index order, so the tail always
 * carries the high-water mark even after the array is front-evicted to
 * `RECENT_CAPTURES_WINDOW`). Snapshotting THIS before a step, then asking the
 * window helpers for captures with a greater index, scopes the scan to the
 * step's own captures WITHOUT depending on the capped array holding them — the
 * eviction-proof replacement for the old `recentCaptures.length` slice index.
 * Returns -1 when nothing has been captured yet (so index 0 is in-window).
 */
export function latestCaptureIndex(recentCaptures: readonly string[]): number {
  for (let i = recentCaptures.length - 1; i >= 0; i--) {
    const name = recentCaptures[i];
    if (name === undefined) continue;
    const idx = parseCaptureIndex(name);
    if (idx !== null) return idx;
  }
  return -1;
}

/**
 * Filenames of the raw captures written AFTER `preIdx` (this step's window),
 * read straight from `capturesDir` — NOT from the in-memory `recentCaptures`
 * array, which is front-evicted to `RECENT_CAPTURES_WINDOW` and therefore drops
 * a step's transition when >20 captures flood during the step (measured 43
 * across one HCA cascade). Scanning disk by filename index is eviction-proof:
 * the transition file is always on disk regardless of array churn. `.decoded.json`
 * sidecars are excluded (the raw file carries `requestPostData`). Sorted by index
 * so callers scan in capture order. Returns [] when the dir is unreadable.
 */
export function capturesAfterIndex(preIdx: number, capturesDir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(capturesDir);
  } catch {
    return [];
  }
  return entries
    .filter((f) => f.endsWith(".json") && !f.endsWith(".decoded.json"))
    .map((f) => ({ f, idx: parseCaptureIndex(f) }))
    .filter((e): e is { f: string; idx: number } => e.idx !== null && e.idx > preIdx)
    .sort((a, b) => a.idx - b.idx)
    .map((e) => e.f);
}

/**
 * Detects a multi-page-wizard RESTART / backward navigation by scanning the
 * captures written during this step for a configured restart-signal pattern
 * (e.g. `init-apply`, `application_canceled=true`). The restart signal is often
 * a plain GET (Talemetry's `GET .../init-apply?...&application_canceled=true`),
 * so it scans the raw capture files' `url` field (GETs are written to disk even
 * though they're dropped from `recentCaptureMeta`). Window scoped by
 * `preIdx` via {@link capturesAfterIndex} (eviction-proof). Returns the matching
 * URL (for the diagnostic) or null. No-op when no `restartSignalUrlPatterns`.
 */

/**
 * Does any same-window network capture's REQUEST BODY match the configured
 * transition pattern? Proves an interior "advance"/"Next" step really moved the
 * wizard forward when advance and non-advance mutations share one endpoint URL
 * (e.g. Talemetry `/gq`: a real advance is a `TransitionWorklet` mutation, a
 * field edit is `EditQuestionItem` — same URL, only the body differs, so a
 * URL/meta-based check can't tell them apart). Window scoped by `preIdx` via
 * {@link capturesAfterIndex} (disk-scan by filename index — eviction-proof, so a
 * transition isn't lost when >20 captures flood during the step). Returns false
 * when no pattern is configured (opt-in) or nothing in the window matches.
 */
export function windowHasTransitionBody(params: {
  preIdx: number;
  advanceTransitionBodyPattern: string | null;
  capturesDir?: string;
}): boolean {
  const { preIdx, advanceTransitionBodyPattern } = params;
  if (!advanceTransitionBodyPattern) return false;
  const capturesDir = params.capturesDir ?? resolveReconRunDir().graphqlDir;
  let rx: RegExp;
  try {
    rx = new RegExp(advanceTransitionBodyPattern);
  } catch {
    return false;
  }
  for (const filename of capturesAfterIndex(preIdx, capturesDir)) {
    try {
      const raw = readFileSync(join(capturesDir, filename), "utf8");
      const capture = JSON.parse(raw) as Partial<Capture> & { requestPostData?: unknown };
      const body =
        typeof capture.requestPostData === "string"
          ? capture.requestPostData
          : JSON.stringify(capture.requestPostData ?? "");
      if (rx.test(body)) return true;
    } catch {
      // Unreadable/absent capture — ignore, keep scanning.
    }
  }
  return false;
}

/**
 * Stricter sibling of {@link windowHasTransitionBody}: a same-window capture
 * whose request body matches the transition pattern AND whose parsed
 * `variables.input.type === "next"`. The mutation NAME alone is a weak
 * distinguisher — on Talemetry a `back` bounce is ALSO a `TransitionWorklet`
 * mutation (its body contains the pattern too) and would wrongly count as an
 * advance; and the fast `WorkletPayload` autosave that precedes the real
 * transition is a different mutation with no `input.type`. Requiring the parsed
 * `type==="next"` isolates a genuine FORWARD advance. Deliberately does NOT use
 * `input.is_next` — it is inverted/unreliable on this ATS (a real `next` carries
 * `is_next:false`, a `back` carries `is_next:true`). Window scoped by `preIdx`
 * via {@link capturesAfterIndex} (eviction-proof disk-scan). Opt-in /
 * site-agnostic: returns false when no pattern is configured.
 */
export function windowHasAdvanceTransition(params: {
  preIdx: number;
  advanceTransitionBodyPattern: string | null;
  capturesDir?: string;
}): boolean {
  const { preIdx, advanceTransitionBodyPattern } = params;
  if (!advanceTransitionBodyPattern) return false;
  const capturesDir = params.capturesDir ?? resolveReconRunDir().graphqlDir;
  let rx: RegExp;
  try {
    rx = new RegExp(advanceTransitionBodyPattern);
  } catch {
    return false;
  }
  for (const filename of capturesAfterIndex(preIdx, capturesDir)) {
    try {
      const raw = readFileSync(join(capturesDir, filename), "utf8");
      const capture = JSON.parse(raw) as Partial<Capture> & { requestPostData?: unknown };
      const body =
        typeof capture.requestPostData === "string"
          ? capture.requestPostData
          : JSON.stringify(capture.requestPostData ?? "");
      if (!rx.test(body)) continue;
      const input = (capture.variables as { input?: { type?: unknown } } | null | undefined)?.input;
      if (input && input.type === "next") return true;
    } catch {
      // Unreadable/absent capture — ignore, keep scanning.
    }
  }
  return false;
}

/**
 * Decide whether the n+16 `el.click()` fallback's "advance" signals should be
 * VETOED — i.e. NOT counted as verifying a wizard transition. Pure + exported so
 * the RC2 gate is unit-testable.
 *
 * An interior "Next" on an SPA where an advance and a mere field-edit share one
 * endpoint (Talemetry `/gq`: TransitionWorklet vs EditQuestionItem — same URL,
 * different body) can fire a network POST that is NOT a real advance; the
 * fallback's htmlDelta/textChanged/checked-radio signals are then validation
 * re-renders / field toggles that don't move the wizard. So for an opted-in
 * (`hasPattern`) non-final/non-submit ADVANCE step, a real advance requires a URL
 * change OR a same-window capture body matching the transition pattern
 * (`retryNetworkIsRealAdvance`); anything less is vetoed. Non-advance/field-answer
 * steps and sites without the pattern are never vetoed here.
 */
export function shouldVetoFallbackAdvance(params: {
  hasPattern: boolean;
  isFinalOrSubmit: boolean;
  isAdvance: boolean;
  retryUrlChanged: boolean;
  retryNetworkIsRealAdvance: boolean;
}): boolean {
  const { hasPattern, isFinalOrSubmit, isAdvance, retryUrlChanged, retryNetworkIsRealAdvance } =
    params;
  if (!hasPattern || isFinalOrSubmit || !isAdvance) return false;
  // Advance step with the pattern configured: veto unless a real transition fired.
  return !(retryUrlChanged || retryNetworkIsRealAdvance);
}

/**
 * Whether a DOM-verified signal should count as verifying an interior ADVANCE
 * step (the PRIMARY verifier's counterpart to {@link shouldVetoFallbackAdvance}).
 * Pure + exported so the RC2-on-the-DOM-branch gate is unit-testable.
 *
 * An advance/"Next" on a pattern-configured SPA is only real when a genuine
 * transition fired — a URL change OR a real `type=next` (`networkIsRealAdvance`).
 * A DOM change alone is a validation re-render / field toggle that never moves
 * the wizard. Crucially this must veto even when a NON-advancing network POST
 * fired (Talemetry's `WorkletPayload` autosave): keying the veto on "no network
 * at all" let a rephrase that triggered an autosave + DOM reflow false-verify an
 * advance, desyncing the flow from the wizard. Returns whether the DOM signal is
 * ALLOWED to verify: false = veto it. Non-advance/field steps, sites without the
 * pattern, and final/submit steps are never vetoed here (DOM stands).
 */
export function isDomOnlyAdvanceVerified(params: {
  hasPattern: boolean;
  isFinalOrSubmit: boolean;
  isAdvance: boolean;
  domVerified: boolean;
  networkIsRealAdvance: boolean;
  urlChanged: boolean;
}): boolean {
  const { hasPattern, isFinalOrSubmit, isAdvance, domVerified, networkIsRealAdvance, urlChanged } =
    params;
  if (!domVerified) return false;
  // Only advance steps on pattern-configured, non-final pages are gated.
  if (!hasPattern || isFinalOrSubmit || !isAdvance) return true;
  // An advance requires a REAL transition; a bare DOM change (even alongside a
  // non-advancing POST) does not verify it.
  return networkIsRealAdvance || urlChanged;
}

/**
 * Read-only count of ng-invalid form controls on the page. Side-effect-free
 * counterpart to `probeFormValidityBeforeSubmit` (which also auto-fills
 * unselected radio groups via element.click()). Used by the cascade's
 * early-exit predicate to detect "the Submit click revealed new required
 * questions" — when this count grows from 0 (pre-submit) to ≥1 (post-attempt-1),
 * attempts 2-5 cannot succeed and the cascade should route to replan
 * immediately instead of burning Stagehand calls.
 */
export async function countNgInvalidContainers(page: Page): Promise<number> {
  const expr = `(() => {
    const isInvalid = ${INVALID_MARKER_EL_EXPR};
    let n = 0;
    for (const el of document.querySelectorAll("[class],[aria-invalid]")) {
      if (isInvalid(el)) n++;
    }
    return n;
  })()`;
  try {
    const raw = await page.evaluate(expr);
    return typeof raw === "number" ? raw : 0;
  } catch {
    return 0;
  }
}

/**
 * Translate the pre/post snapshot delta + same-window captures into a short
 * diagnostic phrase that goes into `failureReasons[]`. Surfaces patterns the
 * verifier itself discards: e.g. "DOM grew but no submit-shaped network
 * request" (client-side validation blocked the form), or "analytics beacon
 * fired but no same-origin submit" (third-party tracking, not real signal).
 * The rephrase + replan LLMs read these strings to choose between "retry the
 * click" and "fill an unanswered required field".
 */
export function describeAttemptEffectSignals(
  pre: StepSnapshot,
  post: StepSnapshot,
  recentCaptureMeta: readonly { method: string; status: number; url: string }[],
  preMetaLength: number
): string {
  const bytesDelta = post.bodyHtmlLength - pre.bodyHtmlLength;
  const networkDelta = post.networkCount - pre.networkCount;
  const textChanged = post.visibleTextSignature !== pre.visibleTextSignature;
  const windowCaptures = recentCaptureMeta.slice(preMetaLength);
  const observations: string[] = [];
  if (networkDelta === 0 && bytesDelta >= 500) {
    observations.push(
      `dom-grew-without-network: body +${bytesDelta}B, ${textChanged ? "visible text changed" : "visible text unchanged"}, 0 same-origin non-GET requests (likely client-side validation rendered errors instead of submitting)`
    );
  }
  if (networkDelta > 0 && windowCaptures.length > 0) {
    const sameOriginNonGet = windowCaptures.filter((m) => m.method !== "GET");
    if (sameOriginNonGet.length === 0) {
      observations.push(
        `network-fired-but-only-tracking: ${windowCaptures.length} requests captured but none were non-GET same-origin (analytics beacons / third-party tracking, not a form submit)`
      );
    }
  }
  if (textChanged && networkDelta === 0 && bytesDelta < 500) {
    observations.push(
      "visible-text-changed-without-network: page reflowed slightly (likely tooltip/focus state)"
    );
  }
  return observations.join(" | ");
}

/**
 * Was the failed step *structurally* unresolvable — i.e. no cascade attempt ever
 * resolved a selector/control for it — as opposed to a control that WAS found but
 * failed to verify? True only when every attempt resolved nothing
 * (`triedSelectors` empty) and none carried a verification signal. The replan
 * prompt uses this to stop merely rewording a step whose target the engine has no
 * driver for (e.g. a custom widget), and instead propose a different path or mark
 * impossible. Conservative: any attempt that resolved a selector or verified makes
 * this false (that step is resolvable; rewording may still help).
 */

/**
 * Decide whether a cascade technique's preconditions cannot be met by the
 * prior attempts' state, so running it would burn the attempt slot without
 * exercising new behaviour. Conservative: returns true ONLY when the
 * predicate can prove the technique is mathematically unable to succeed;
 * anything ambiguous falls through to "run the attempt" so the cascade
 * keeps healing opportunistically.
 */
export function shouldSkipTechnique(params: {
  technique:
    | "act-string"
    | "observe-act"
    | "structured-click"
    | "observe-act-exclude"
    | "deep-submit-locator"
    | "llm-rephrase";
  priorAttempts: readonly {
    technique: string;
    triedSelectors: readonly string[];
    errorMessage: string | null;
  }[];
  /**
   * True when the step is a wizard ADVANCE ("Next") whose attempt-1 produced no
   * real forward transition — either a non-advancing POST or no observable
   * effect at all. Optional so existing callers are unchanged.
   */
  advanceUnmovedAfterAttempt1?: boolean;
  /**
   * True when attempt 1 reported success but the pre/post snapshot shows zero
   * observable effect (see {@link classifyPhantomClick}) — a phantom click.
   * Re-observing/re-clicking the light DOM will no-op identically (the target
   * is almost certainly unreachable via `document.querySelectorAll`, e.g.
   * inside a shadow root), so skip straight to the deep submit-control locator
   * instead of burning attempts 2-4 repeating the same no-op. Optional so
   * existing callers are unchanged.
   */
  phantomClickAfterAttempt1?: boolean;
}): { skip: boolean; reason: string } {
  const { technique, priorAttempts, advanceUnmovedAfterAttempt1, phantomClickAfterAttempt1 } =
    params;
  // Unmoved-advance short-circuit (measured: attempts 2-4 recovered a stuck
  // advance 0 times in 289 steps). When attempt-1's act-string clicked the Next
  // and the wizard did NOT move forward (non-advancing POST, or no effect),
  // re-observing/re-clicking the same button cannot move it — only a rephrase (a
  // different action) or the terminal replan can. So skip observe-act /
  // structured-click / observe-act-exclude and let the cascade reach attempt-5
  // rephrase (kept — the ONE attempt that has ever recovered an advance) or fail
  // fast to replan. act-string (attempt 1) and llm-rephrase (attempt 5) are never
  // skipped here. (The `isAdvanceStalled` early-exit already handles the
  // network-fired subcase by breaking to replan; this also covers the
  // no-effect-at-all subcase, where that early-exit does not fire.)
  if (
    advanceUnmovedAfterAttempt1 === true &&
    (technique === "observe-act" ||
      technique === "structured-click" ||
      technique === "observe-act-exclude")
  ) {
    return {
      skip: true,
      reason:
        "advance step did not move the wizard on attempt 1; re-observe/re-click cannot advance it — skipping to rephrase/replan",
    };
  }
  // Phantom-click short-circuit: attempt 1 clicked something Stagehand
  // believes exists, but pre/post shows zero network, zero URL change, and
  // no real DOM growth — the click almost certainly landed on nothing (the
  // recon-submit-phantom-click bug report's light-DOM resolver can't see
  // into a shadow root / web component). Repeating observe-act /
  // structured-click / observe-act-exclude re-resolves the SAME
  // light-DOM-only view of the page and would no-op identically, so skip
  // straight to deep-submit-locator (attempt 2) instead. llm-rephrase
  // (attempt 5) is never skipped — a differently-worded instruction is still
  // a distinct attempt worth trying if the deep locator also fails.
  if (
    phantomClickAfterAttempt1 === true &&
    (technique === "observe-act" ||
      technique === "structured-click" ||
      technique === "observe-act-exclude")
  ) {
    return {
      skip: true,
      reason:
        "attempt 1 was a phantom click (reported success, zero observable effect); re-observe/re-click cannot reach a target the light-DOM resolver can't see — escalating to the deep submit-control locator",
    };
  }
  if (technique === "structured-click") {
    const anyXpathResolved = priorAttempts.some((a) => a.triedSelectors.length > 0);
    if (!anyXpathResolved) {
      return {
        skip: true,
        reason:
          "structured-click needs a prior xpath; no attempt has resolved a selector yet — skipping to next technique",
      };
    }
  }
  if (technique === "observe-act-exclude") {
    const observeAct2 = priorAttempts.find((a) => a.technique === "observe-act");
    if (
      observeAct2 &&
      observeAct2.errorMessage === "observe returned no candidates" &&
      observeAct2.triedSelectors.length === 0
    ) {
      return {
        skip: true,
        reason:
          "observe-act-exclude re-runs the same observe with exclusions; prior observe-act returned 0 candidates — no new candidates to surface, skipping",
      };
    }
  }
  return { skip: false, reason: "" };
}

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
export function isSubmitRevealedInvalid(params: {
  isFinalStep: boolean;
  requireSubmitEndpoint: boolean;
  resolvedMethod: string | null;
  effectSignals: string;
  preSubmitInvalidCount: number;
  postAttemptInvalidCount: number;
}): boolean {
  const {
    isFinalStep,
    requireSubmitEndpoint,
    resolvedMethod,
    effectSignals,
    preSubmitInvalidCount,
    postAttemptInvalidCount,
  } = params;
  if (!isFinalStep) return false;
  if (!requireSubmitEndpoint) return false;
  if (resolvedMethod !== "click") return false;
  if (!effectSignals.includes("dom-grew-without-network")) return false;
  if (postAttemptInvalidCount <= preSubmitInvalidCount) return false;
  return true;
}

/**
 * Decide whether attempt 1 on an interior wizard-ADVANCE step already proved
 * that clicking cannot move the wizard, so attempts 2-N are dead work. When the
 * step is an advance step on a site with the transition-body gate configured,
 * the click DID fire (Stagehand resolved and clicked a button — `clickFired`)
 * and network traffic happened, yet no real `TransitionWorklet(type="next")`
 * landed within the poll window (`networkIsRealAdvance` false), the button works
 * but the wizard is refusing to advance (a precondition isn't met, e.g. a
 * required field the flow answers on a LATER step). Re-clicking the same button
 * only re-fires the autosave / a `back` bounce — measured across HCA runs as the
 * next→back oscillation. Break to replan instead, which can reorder a later step
 * forward. Conservative: any condition unmet → run the full cascade as before.
 * Never fires on final/submit steps (they own `isSubmitRevealedInvalid`) or on
 * sites without the pattern.
 */
export function isAdvanceStalled(params: {
  isAdvance: boolean;
  isFinalOrSubmit: boolean;
  hasPattern: boolean;
  clickFired: boolean;
  networkFired: boolean;
  networkIsRealAdvance: boolean;
  urlChanged: boolean;
}): boolean {
  const {
    isAdvance,
    isFinalOrSubmit,
    hasPattern,
    clickFired,
    networkFired,
    networkIsRealAdvance,
    urlChanged,
  } = params;
  if (!isAdvance || isFinalOrSubmit || !hasPattern) return false;
  if (!clickFired) return false;
  if (urlChanged || networkIsRealAdvance) return false;
  // The button clicked and something hit the network, but it wasn't a real
  // forward transition — the wizard is stalled, not the click technique.
  return networkFired;
}

/**
 * Lazy Anthropic client for attempt 4's rephrase. Returns null when the
 * deployment is Bedrock-only (no ANTHROPIC_API_KEY) — attempt 4 then becomes
 * a no-op and the executor escalates straight to the failure dump. The other
 * three attempts already cover the lion's share of recovery.
 */

/**
 * Strip the `anthropic/` prefix Stagehand expects on `STAGEHAND_MODEL` so the
 * Anthropic SDK sees the bare model id (e.g. `claude-sonnet-4-6`).
 */
export function anthropicModelName(): string {
  const raw = config.scraper.model;
  return raw.startsWith("anthropic/") ? raw.slice("anthropic/".length) : raw;
}

/** Injectable capture function — matches `captureLlmCall`'s signature. */
export type CaptureFn = (input: LlmCallInput) => Promise<void>;

/**
 * System prompt for the recon-rephrase call. Carries the durable contract
 * (single rule: target a different element OR return outcome=impossible),
 * leaving the user prompt for evidence and the active rewrite query. Per
 * Anthropic guidance, rules/constraints belong in `system`; the user prompt
 * is the per-call data.
 */
const REPHRASE_SYSTEM_PROMPT =
  "You rewrite a failed Stagehand act() instruction so the next attempt targets a different element than those already tried. If no different element exists on the page that could plausibly unblock the flow, return outcome=impossible. Never re-propose a selector or wording from the lists labeled SELECTORS ALREADY TRIED or INSTRUCTION TEXT ALREADY TRIED.";

/**
 * Attempt-4 of the step-healing cascade: when three mechanical retry variations
 * all fail, this is the last resort before the step is declared terminal. Exported
 * so tests can inject a fake capture sink without touching the browser session.
 */
export async function rephraseWithLLM(
  client: Anthropic,
  originalStep: string,
  triedSelectors: string[],
  observeCandidates: Action[],
  failureReasons: string[],
  captureFn: CaptureFn = captureLlmCall,
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
  }[],
  /**
   * Optional rendered Google Analytics Measurement Protocol event list
   * (output of `extractGaEventEvidence`). When non-empty, surfaces SPA-
   * internal page transitions (view_secondPage), success signals
   * (view_thankYouPage), and the site's own validator counts
   * (epn.validationErrorsCount) so the rephrase LLM can pivot off
   * "click harder" into "fill the actually-missing field." Telemetry
   * the engine already captures but never showed the LLM until now.
   */
  gaEventEvidence?: string
): Promise<string | null> {
  const candidateList = observeCandidates
    .slice(0, 12)
    .map((a, i) => `${i + 1}. ${a.description} — ${a.selector}`)
    .join("\n");
  const unfocusedList = unfocusedObserve
    ? await renderUnfocusedObserve(unfocusedObserve, { client, captureFn })
    : "";
  const triedList = triedSelectors.length > 0 ? triedSelectors.join("\n") : "(none)";
  const reasonList = failureReasons.map((r, i) => `attempt ${i + 1}: ${r}`).join("\n");
  const invalidFieldList = pageEvidence?.invalidFieldList ?? "";
  const errorTextList = pageEvidence?.errorTextList ?? "";
  const interactiveTargetsList = pageEvidence?.interactiveTargetsList ?? "";
  const priorInstructionList = (priorAttempts ?? [])
    .filter((a) => typeof a.instruction === "string" && a.instruction.trim().length > 0)
    .map(
      (a, i) =>
        `${i + 1}. [${a.technique}] "${a.instruction}" → ${a.verdict ?? "(no verdict captured)"}`
    )
    .join("\n");

  // V4-C structural fix: when off-target redirect evidence exists (invalid
  // fields + clickable options under them), prepend a context block ABOVE
  // ORIGINAL INSTRUCTION. Empirically validated 3/3 PIVOT vs 3/3 FIXATE on
  // the production Good Samaritan rephrase prompt (A/B against
  // claude-opus-4-7). Mechanism: `ORIGINAL INSTRUCTION:` at the top of a
  // long prompt anchors the LLM to the wrong task even with a buried
  // redirect directive. Any meaningful content above it breaks the anchor.
  // When the conditional doesn't fire (no invalid evidence), the prompt is
  // byte-identical to the previous version.
  const hasRedirectEvidence = invalidFieldList.length > 0 && interactiveTargetsList.length > 0;
  const redirectBlock = hasRedirectEvidence
    ? `Important context: the form is currently blocked by OTHER fields than the one mentioned in the original instruction. Resolving the original instruction's element will not unblock the form. Your rewrite should target one of the fields below.

FORM FIELDS CURRENTLY MARKED INVALID:
${invalidFieldList}

INTERACTIVE TARGETS NEAR INVALID FIELDS:
${interactiveTargetsList}

For yes/no questions, choose the candidate-favorable answer ('No' for adverse questions like non-compete; 'Yes' for confirmations like work-authorized; 'Prefer not to say' for demographic disclosures). Your one-sentence rewrite targets one of the bracketed [Question Title] options above.

---

`
    : "";

  const prompt = `You are helping a browser automation agent recover from a failed step in a recon flow.

${redirectBlock}ORIGINAL INSTRUCTION:
${originalStep}

WHY EARLIER ATTEMPTS FAILED:
${reasonList}

SELECTORS ALREADY TRIED (avoid these):
${triedList}

INSTRUCTION TEXT ALREADY TRIED (do not re-propose these wordings or near-synonyms — they all produced the verdict shown after the arrow):
${priorInstructionList || "(none)"}

ELEMENTS CURRENTLY VISIBLE ON THE PAGE (filtered by the failed instruction):
${candidateList || "(no candidates returned by observe)"}

UNFOCUSED OBSERVE (what Stagehand sees on the page without any instruction filter — modal/dialog/overlay/popup entries are prioritized; use this to detect blocking UI like open modals with Save buttons that the focused observe above hid):
${unfocusedList || "(none)"}

FORM FIELDS CURRENTLY MARKED INVALID (text + class signature for any element whose class matches the framework-agnostic invalid pattern — ng-invalid, mat-form-field-invalid, is-invalid, etc. — use this to detect "filled a field, then a downstream re-render wiped it" patterns where the verifier reports no observable effect but the form is actually invalid):
${invalidFieldList || "(none)"}

VISIBLE ERROR / REQUIRED-FIELD MESSAGES ON THE PAGE (extracted text from error-class containers):
${errorTextList || "(none)"}

INTERACTIVE TARGETS NEAR INVALID FIELDS (radio labels, dropdown options, inputs found UNDER each ng-invalid / mat-form-field-invalid / is-invalid container — these are the elements you can click/fill to clear the corresponding invalid state; the bracketed [Question Title] is the parent question text when one was discoverable):
${interactiveTargetsList || "(none)"}

STRUCTURED SERVER-SIDE VALIDATION ERRORS (parsed from captured 4xx responses to the configured submit endpoint — when this is populated, the form's submit DID fire and the server rejected it with specific field-level feedback; use these field+message pairs to decide which input needs correcting):
${submitFailureList || "(none)"}

PAGE TRANSITION + VALIDATOR TELEMETRY (parsed from Google Analytics Measurement Protocol beacons (POSTs to google-analytics.com/g/collect) captured during the failed step's attempt window — the SPA's own telemetry. Watch for: en=view_secondPage / en=view_thirdPage = the SPA advanced to a later form page WITHOUT firing Page.frameNavigated (URL stays the same but the questions changed); en=view_thankYouPage = the application SUBMITTED SUCCESSFULLY (a stronger success signal than network captures because /integrated_apply POSTs are sometimes debounced); epn.validationErrorsCount=N = the site's own client validator counts N unfilled required fields. When validationErrorsCount > 0, prefer targeting an unfilled field over re-clicking Submit/Continue. When view_thankYouPage appears, the form already submitted — emit outcome=impossible because there is nothing left to click):
${gaEventEvidence || "(none)"}

Rewrite the instruction so a Stagehand act() call can resolve it unambiguously to a different element than the ones already tried. Keep it short — one sentence, natural language, no quotes around it. If the invalid-fields section above names a field AND the interactive-targets section below lists clickable options inside that same container, your rewrite picks one of those options (e.g. for a yes/no question rendered as two radio labels, choose the candidate-favorable answer — 'No' for "do you have a non-compete", 'Yes' for "are you authorized to work", 'Prefer not to say' for demographic disclosures) rather than retrying the original click. If the unfocused observe section shows an open modal/dialog with a Save or Close action, your rewrite invokes that action so the underlying form can clear its blocking state. Set outcome to "impossible" with a one-line reason only when the original instruction's element does not exist on the current page and no redirect target is available.`;

  const model = anthropicModelName();
  const t0 = performance.now();
  try {
    const response = await client.messages.parse({
      model,
      max_tokens: 400,
      system: REPHRASE_SYSTEM_PROMPT,
      messages: [{ role: "user", content: prompt }],
      output_config: {
        format: zodOutputFormat(REPHRASE_RESPONSE_SCHEMA),
      },
    });
    const latencyMs = performance.now() - t0;
    const parsed = response.parsed_output;
    if (parsed === null) {
      throw new Error("structured-output enabled but parsed_output is null");
    }
    const textBlock = response.content.find((b) => b.type === "text");
    const rawText = textBlock?.type === "text" ? textBlock.text : "";

    await captureFn({
      callId: randomUUID(),
      callType: CALL_TYPE_RECON_REPHRASE,
      model,
      systemPrompt: REPHRASE_SYSTEM_PROMPT,
      userContent: prompt,
      responseContent: rawText,
      parsedOk: true,
      inputTokens: response.usage?.input_tokens ?? null,
      outputTokens: response.usage?.output_tokens ?? null,
      latencyMs,
      success: true,
      errorMessage: null,
      failureKind: null,
    });

    if (parsed.outcome === "impossible") return null;
    return parsed.instruction;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logBillingErrorIfPresent(err);
    await captureFn({
      callId: randomUUID(),
      callType: CALL_TYPE_RECON_REPHRASE,
      model,
      systemPrompt: REPHRASE_SYSTEM_PROMPT,
      userContent: prompt,
      responseContent: null,
      parsedOk: false,
      inputTokens: null,
      outputTokens: null,
      latencyMs: performance.now() - t0,
      success: false,
      errorMessage: message,
      failureKind: classifyLlmCallFailure(err),
    });
    return null;
  }
}

/**
 * Detect terminal Anthropic API errors that the cascade can't possibly
 * recover from (credit/billing exhaustion). Logs a single FATAL banner
 * the first time per-process so the runner script can scan stdout and
 * short-circuit a multi-job sweep instead of burning more browser
 * sessions on jobs that will fail identically.
 */
let billingErrorLoggedThisProcess = false;

/**
 * Getter for the module-private billing-exhausted flag. Exported so the
 * cascade's attempt-5 guard can read it without coupling to module-level
 * state directly; also lets tests reset / observe the flag without
 * mutating shared globals.
 */
export function hasBillingErrorBeenLogged(): boolean {
  return billingErrorLoggedThisProcess;
}

/**
 * Test-only reset. Tests that exercise the billing-exhausted path need to
 * clear the per-process flag between cases; production code never resets it.
 */
export function resetBillingErrorFlagForTests(): void {
  billingErrorLoggedThisProcess = false;
}

export function logBillingErrorIfPresent(err: unknown): boolean {
  if (classifyLlmCallFailure(err) !== "anthropic-billing") return false;
  if (billingErrorLoggedThisProcess) return true;
  billingErrorLoggedThisProcess = true;
  // FATAL_BILLING is a machine marker, not prose — the recon-replay-jobs
  // runner regex-greps child stdout for this literal to short-circuit
  // multi-job sweeps on Anthropic credit exhaustion. The uppercase is
  // load-bearing; do not lowercase it.
  logger.fatal(
    "FATAL_BILLING: Anthropic API rejected the call due to insufficient credit balance. Cascade cannot heal further. Top up at https://console.anthropic.com/billing then re-run."
  );
  return true;
}

/**
 * Pull the raw-DOM and unfocused-observe evidence out of an on-disk failure
 * dump so the replanner prompt can include ground truth, not just stagehand's
 * LLM-filtered candidate list. The dump file is a trust boundary (anything
 * could be on disk), so the body field is type-narrowed before slicing.
 */
/** Cap on the unfocused-observe list rendered into LLM-recovery prompts. */
const UNFOCUSED_OBSERVE_CAP = 30;

/**
 * Render an unfocused-observe array into a numbered string the prompt can
 * consume, prioritizing any modal/dialog/overlay/popup entries to the top
 * regardless of their index in the raw list. Without this prefix, modals
 * that Stagehand observes at index 70+ (verified against the prior run's
 * dump — 11 modal entries lived at positions 64-79 of 80) get truncated
 * away by the cap and the LLM-replan can't propose to save/close them.
 */
export async function renderUnfocusedObserve(
  observations: Action[],
  options?: {
    cap?: number;
    client?: Anthropic | null;
    captureFn?: CaptureFn;
  }
): Promise<string> {
  const cap = options?.cap ?? UNFOCUSED_OBSERVE_CAP;
  const client = options?.client ?? null;
  const captureFn = options?.captureFn;

  if (observations.length === 0) return "";

  // Ask the Haiku judge which observations are blocking modals/dialogs/
  // overlays. Returns indices to bubble to the top. When the judge is
  // unavailable (null client / API failure), we leave the original order
  // untouched — fail-safe: showing observations in source order is the
  // pre-migration baseline. Stagehand's LLM-emitted descriptions
  // already tend to cluster modals near the top of its results, so the
  // ordering on the fallback path isn't catastrophic.
  const judgeVerdict = await judgeModalPriorityWithLLM({
    client,
    input: {
      observations: observations.map((a) => ({
        description: a.description || "",
        selector: a.selector,
      })),
    },
    captureFn,
  });

  let combined: Action[];
  if (judgeVerdict !== null && judgeVerdict.priorityIndices.length > 0) {
    const priorityIdx = new Set(judgeVerdict.priorityIndices);
    const priorityHits: Action[] = [];
    const others: Action[] = [];
    observations.forEach((a, i) => {
      if (priorityIdx.has(i)) priorityHits.push(a);
      else others.push(a);
    });
    combined = [...priorityHits, ...others].slice(0, cap);
  } else {
    combined = observations.slice(0, cap);
  }

  return combined.map((a, i) => `${i + 1}. ${a.description} — ${a.selector}`).join("\n");
}

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
export function pairInvalidWithErrors(
  invalidFieldList: string,
  errorTextList: string
): ValidationRejectionPair[] {
  if (invalidFieldList.length === 0 || errorTextList.length === 0) return [];
  const invalidLines = invalidFieldList.split("\n").filter((l) => l.trim().length > 0);
  const errorLines = errorTextList.split("\n").filter((l) => l.trim().length > 0);
  if (invalidLines.length === 0 || errorLines.length === 0) return [];
  const pairs: ValidationRejectionPair[] = [];
  const max = Math.min(invalidLines.length, errorLines.length);
  for (let i = 0; i < max; i++) {
    const inv = invalidLines[i] ?? "";
    const err = errorLines[i] ?? "";
    // Gate: only emit when the invalid container is touched+dirty
    // (we filled it, validator rejected the value).
    if (!(inv.includes("ng-touched") && inv.includes("ng-dirty"))) continue;
    // Strip the leading "N. " prefix the list formatter adds.
    const fieldLabel = inv.replace(/^\d+\.\s*/, "").trim();
    const errorText = err.replace(/^\d+\.\s*/, "").trim();
    if (fieldLabel.length === 0 || errorText.length === 0) continue;
    pairs.push({
      fieldLabel: fieldLabel.slice(0, 200),
      errorText: errorText.slice(0, 200),
    });
  }
  return pairs;
}

/**
 * Format a {@link ValidationRejectionPair} as a single-line failureReason
 * string the LLM reads from the replan prompt's WHY VERIFICATION FAILED
 * block. Style matches existing reason formats (`submit-revealed-invalid`,
 * `submit-endpoint-not-matched`): leading category tag, then the facts,
 * then a brief imperative for what the LLM should do.
 */
export function formatValidationRejectedReason(pair: ValidationRejectionPair): string {
  return `validation-rejected: '${pair.fieldLabel}' rejected with '${pair.errorText}'; propose a different value or return impossible`;
}

const BODY_EXCERPT_DEFAULT_CAP = 8_000;
// Window of HTML handed to the invalid-fields / error-messages haiku judges,
// centered on the first form/error marker (start = marker − WINDOW/4). Measured
// from telemetry: the invalid marker the judge needs sits ~WINDOW/4 into the
// window every time, so 16KB keeps it centered (±4KB) while halving the prompt
// (the removed tail is markup the judge doesn't use). Larger triggers judge.ts's
// "large prompt; consider trimming for latency" warning.
const BODY_EXCERPT_FORM_WINDOW = 16_000;

/**
 * Pick a window of `body` that's likely to contain the form's structural
 * evidence (ng-invalid markers, error messages, question labels) that the
 * downstream Haiku judges need to populate the replan/rephrase prompt's
 * FORM FIELDS section.
 *
 * Default: first 8KB. That window held for tenants whose form was at the
 * top of the page (early sweeps in 2026-06).
 *
 * For pages where the form HTML lives below 8KB (verified on AppCast's
 * applyboard SPA: ng-invalid first appears at byte ~15,500 after a header
 * of Angular hydration JS + chrome), the 8KB cap silently produced
 * "FORM FIELDS CURRENTLY MARKED INVALID: (none)" in the replan prompt,
 * leaving the LLM with no evidence and causing it to hallucinate steps
 * from the existing flow's tenant content. The smart path: when an
 * `ng-invalid` or `<form` token appears beyond the default cap, return a
 * window of FORM_WINDOW bytes centered on the marker so the judge sees
 * the actual form structure.
 *
 * Site-agnostic: the markers we look for (ng-invalid, mat-form-field-
 * invalid, is-invalid, <form) are framework-level CSS-class conventions
 * used across countless SPAs, not AppCast-specific.
 */
export function selectBodyExcerpt(body: string): string {
  if (body.length <= BODY_EXCERPT_DEFAULT_CAP) return body;
  const defaultExcerpt = body.slice(0, BODY_EXCERPT_DEFAULT_CAP);
  if (
    /ng-invalid|mat-form-field-invalid|is-invalid|Mui-error|<form\b|questions-container/.test(
      defaultExcerpt
    )
  ) {
    return defaultExcerpt;
  }
  const searchFrom = BODY_EXCERPT_DEFAULT_CAP;
  const markerIndex = body
    .slice(searchFrom)
    .search(/ng-invalid|mat-form-field-invalid|is-invalid|Mui-error|<form\b|questions-container/);
  if (markerIndex < 0) return defaultExcerpt;
  const absoluteIndex = searchFrom + markerIndex;
  const start = Math.max(0, absoluteIndex - BODY_EXCERPT_FORM_WINDOW / 4);
  return body.slice(start, start + BODY_EXCERPT_FORM_WINDOW);
}

async function extractLivePageFormEvidence(
  page: Page,
  options?: {
    client?: Anthropic | null;
    knownErrorClassPrefixes?: readonly string[];
    captureFn?: CaptureFn;
  }
): Promise<{
  invalidFieldList: string;
  errorTextList: string;
  interactiveTargetsList: string;
}> {
  let body = "";
  try {
    const raw = await page.evaluate("document.body ? document.body.outerHTML : null");
    if (typeof raw === "string") body = raw;
  } catch {
    return { invalidFieldList: "", errorTextList: "", interactiveTargetsList: "" };
  }

  // Pick a body excerpt that's likely to contain the form's invalid-field
  // markers. Default 8KB cap unless the body has ng-invalid / <form past
  // the cap (typical of AppCast applyboard SPA, where the form starts
  // ~15KB into a page of Angular hydration scaffolding). See
  // selectBodyExcerpt for details.
  const bodyExcerpt = selectBodyExcerpt(body);

  const client = options?.client ?? null;
  const knownErrorClassPrefixes = options?.knownErrorClassPrefixes ?? [];
  const captureFn = options?.captureFn;

  // Deterministic-first: run the DOM probe synchronously alongside the
  // error-messages judge + interactive-targets extraction. The probe uses
  // CSS `:has()` to find only LEAF invalid containers — bubbled parents
  // (Angular's `<ol class="ng-invalid">` matching because a descendant is
  // invalid) are filtered out structurally. Falls back to the Haiku
  // invalid-fields judge ONLY when the probe returns empty (truly novel
  // framework convention the selector list doesn't cover). Reason for
  // the inversion: today's smoke (run 1781478440322) showed Haiku
  // surfaced `(unlabeled) <ol>` for 3 replans + 4 rephrases, and all 7
  // LLM calls converged on "Click Continue" because no specific fillable
  // field was named in FORM FIELDS. Deterministic extraction gives the
  // LLM `"Address" <app-input> — error: "This field is required"` instead.
  const [leafFields, errorVerdict, interactiveTargets] = await Promise.all([
    probeLeafInvalidContainers(page),
    judgeErrorMessagesWithLLM({
      client,
      input: { bodyHtmlExcerpt: bodyExcerpt },
      captureFn,
    }),
    extractInteractiveTargetsNearInvalid(page).catch(() => [] as string[]),
  ]);

  // Probe is the primary signal. Judge only runs if probe is empty AND a
  // client is available — so the fallback semantics match today's behavior
  // exactly when the deterministic path returns nothing.
  const invalidFieldList =
    leafFields.length > 0
      ? renderLeafInvalidFields(leafFields)
      : await (async (): Promise<string> => {
          const verdict = await judgeInvalidFieldsWithLLM({
            client,
            input: { bodyHtmlExcerpt: bodyExcerpt, knownErrorClassPrefixes },
            captureFn,
          });
          const lines =
            verdict?.fields.map((f) => {
              const label = f.label ?? "(unlabeled)";
              return `${label}  [${f.framework} ${f.markerKind}] ${f.containerXpath}`;
            }) ?? [];
          return lines.map((e, i) => `${i + 1}. ${e}`).join("\n");
        })();

  const errorLines =
    errorVerdict?.messages.map((m) => {
      const field = m.fieldHint ? `[${m.fieldHint}] ` : "";
      return `${field}${m.severity}: ${m.text}`;
    }) ?? [];

  return {
    invalidFieldList,
    errorTextList: errorLines.map((e, i) => `${i + 1}. ${e}`).join("\n"),
    interactiveTargetsList: interactiveTargets.map((e, i) => `${i + 1}. ${e}`).join("\n"),
  };
}

/**
 * For each container marked invalid by the framework's validity classes,
 * walk the DOM tree under it and surface clickable descendants (radio
 * labels, dropdown options, text inputs) with an xpath the rephrase LLM
 * can hand directly to Stagehand's act(). Closes the gap where the
 * rephrase prompt carries "field X is invalid" but no selector for the
 * radio/option that would clear it — so the LLM proposes "click Submit
 * harder" instead of "answer field X with Yes/No".
 */
/**
 * Structured leaf-invalid-container record emitted by `probeLeafInvalidContainers`.
 * Replaces the LLM-judge's `{ containerXpath, label, framework, markerKind }` shape
 * with a deterministic-only record carrying everything the prompt needs to surface
 * a specific actionable target ("the Address field, an Angular smart-address
 * autocomplete component, error text 'This field is required'").
 */
export interface LeafInvalidField {
  /** Best-effort xpath of the leaf invalid container itself. */
  xpath: string;
  /** Nearest discoverable label text walking up from the container, null if not findable. */
  label: string | null;
  /** Which framework convention triggered the leaf match. */
  framework: "angular" | "material" | "bootstrap" | "aria" | "other";
  /** The actual class signature on the container that matched (debug aid). */
  markerClass: string;
  /** Any visible error/required-message text in an adjacent error container. */
  visibleErrorText: string | null;
  /** Tag of the input element inside the container (input, app-input, etc.). */
  inputTag: string;
}

/**
 * Deterministic DOM probe for LEAF invalid form containers, replacing the
 * LLM-judge's stochastic "prefer the deepest container" heuristic. Uses the
 * native CSS `:has()` selector — universally supported as of 2023 (Chrome 105+,
 * we run Chrome 149) — to query only containers whose `ng-invalid` /
 * `mat-form-field-invalid` / `is-invalid` / `aria-invalid` marker is NOT
 * shadowed by a same-marker descendant. That's the exact definition of "leaf"
 * in Angular's invalidity-bubbling model: a `<ol class="ng-invalid">` parent
 * matches `ng-invalid` because of bubbling, but its child `<app-input
 * class="ng-invalid">` ALSO matches; `:not(:has(...))` filters out the parent.
 *
 * Today's Encompass-Fitchburg smoke (run 1781478440322) showed E1's prompt
 * instruction ("prefer the leaf, not the bubbled parent") only got Haiku from
 * 5 wrong fields → 1 wrong field — still surfaced `(unlabeled) <ol>` instead
 * of `<app-input autocomplete="zip-code">` at byte 95,033. All 3 replans + 4
 * rephrases then converged on "Click Continue" because the FORM FIELDS section
 * never named a specific fillable target. Switching to deterministic extraction
 * is industry-standard: Anthropic's prompt-engineering guidance says "use the
 * LLM for fuzzy judgment, deterministic extraction for structurally-derivable
 * signals" — DOM tree walking is the latter.
 *
 * Returns up to 12 leaf records. Empty array on `page.evaluate` failure (safe
 * fallback to the existing Haiku judge upstream). The `inputTag` and
 * `visibleErrorText` fields let the prompt distinguish a smart-address
 * autocomplete (where typing-only fails and the cascade needs dropdown
 * selection) from a plain text input.
 */
export async function probeLeafInvalidContainers(page: Page): Promise<LeafInvalidField[]> {
  const expr = `(() => {
    const SELECTOR =
      "[class*='ng-invalid']:not(:has([class*='ng-invalid'])), " +
      "[class*='mat-form-field-invalid']:not(:has([class*='mat-form-field-invalid'])), " +
      "[class*='is-invalid']:not(:has([class*='is-invalid'])), " +
      "[class*='field-invalid']:not(:has([class*='field-invalid'])), " +
      "[aria-invalid='true']:not(:has([aria-invalid='true']))";
    const containers = document.querySelectorAll(SELECTOR);
    const out = [];
    const seen = new Set();
    function xpathOf(node) {
      const parts = [];
      while (node && node.nodeType === 1 && node !== document.body) {
        const tag = node.nodeName.toLowerCase();
        let idx = 1;
        let sib = node.previousElementSibling;
        while (sib) {
          if (sib.nodeName.toLowerCase() === tag) idx++;
          sib = sib.previousElementSibling;
        }
        parts.unshift(tag + "[" + idx + "]");
        node = node.parentElement;
      }
      return "/html[1]/body[1]/" + parts.join("/");
    }
    function labelFor(container) {
      let n = container;
      for (let i = 0; i < 6 && n; i++) {
        const cand = n.querySelector
          ? n.querySelector(".uapp-html-markup, .question-title, .question-label, .group-title, label")
          : null;
        if (cand && cand.textContent) {
          const t = cand.textContent.trim().replace(/\\s+/g, " ");
          if (t.length > 1 && t.length < 200) return t;
        }
        n = n.parentElement;
      }
      return null;
    }
    function errorTextFor(container) {
      let n = container;
      for (let i = 0; i < 4 && n; i++) {
        const cand = n.querySelector
          ? n.querySelector("app-control-errors p, mat-error, .error-message, .field-error, .validation-error, .invalid-feedback, [class*='error']:not([class*='boundary'])")
          : null;
        if (cand && cand.textContent) {
          const t = cand.textContent.trim().replace(/\\s+/g, " ");
          if (t.length > 3 && t.length < 200 && !/^\\s*$/.test(t)) return t;
        }
        n = n.parentElement;
      }
      return null;
    }
    function frameworkFor(cls, ariaInv) {
      if (cls.indexOf("mat-form-field-invalid") >= 0) return "material";
      if (cls.indexOf("ng-invalid") >= 0) return "angular";
      if (cls.indexOf("is-invalid") >= 0) return "bootstrap";
      if (cls.indexOf("field-invalid") >= 0) return "other";
      if (ariaInv) return "aria";
      return "other";
    }
    for (const c of containers) {
      if (out.length >= 12) break;
      const xp = xpathOf(c);
      if (seen.has(xp)) continue;
      seen.add(xp);
      const cls = (c.getAttribute("class") || "").slice(0, 200);
      const ariaInv = c.getAttribute("aria-invalid") === "true";
      const inputEl = c.tagName.toLowerCase() === "input"
        ? c
        : c.querySelector("input, textarea, select, app-input, app-dropdown, app-autocomplete, uapp-phone-input, uapp-resume-upload, uapp-upload");
      const inputTag = inputEl ? inputEl.tagName.toLowerCase() : c.tagName.toLowerCase();
      out.push({
        xpath: xp,
        label: labelFor(c),
        framework: frameworkFor(cls, ariaInv),
        markerClass: cls,
        visibleErrorText: errorTextFor(c),
        inputTag: inputTag,
      });
    }
    return out;
  })()`;
  try {
    const result = await page.evaluate(expr);
    return Array.isArray(result) ? (result as LeafInvalidField[]) : [];
  } catch {
    // page.evaluate failure (navigation in-flight, CSP, browser detached)
    // is non-fatal — caller falls back to the Haiku judge.
    return [];
  }
}

/**
 * Render a list of structured leaf-invalid records as the numbered evidence
 * lines the prompt's FORM FIELDS section expects. Surfaces label + framework
 * + input tag + visible error text in one line so the LLM can disambiguate
 * a smart-address autocomplete from a plain text input (separate widget
 * interaction patterns) and target the field by its real name instead of
 * the `(unlabeled) <ol>` bubble parent the LLM-judge surfaced today.
 */
export function renderLeafInvalidFields(fields: readonly LeafInvalidField[]): string {
  if (fields.length === 0) return "";
  const lines = fields.map((f, i) => {
    const label = f.label ?? "(unlabeled)";
    const err = f.visibleErrorText ? ` — error: "${f.visibleErrorText}"` : "";
    return `${i + 1}. "${label}" [${f.framework}] <${f.inputTag}>${err} at ${f.xpath}`;
  });
  return lines.join("\n");
}

async function extractInteractiveTargetsNearInvalid(page: Page): Promise<string[]> {
  const expr = `(() => {
    const out = [];
    const containers = document.querySelectorAll(
      "[class*='ng-invalid'], [class*='mat-form-field-invalid'], [class*='is-invalid'], [class*='field-invalid'], [class*='input-invalid'], [class*='form-invalid']"
    );
    const seen = new Set();
    function xpathOf(node) {
      const parts = [];
      while (node && node.nodeType === 1 && node !== document.body) {
        const tag = node.nodeName.toLowerCase();
        let idx = 1;
        let sib = node.previousElementSibling;
        while (sib) {
          if (sib.nodeName.toLowerCase() === tag) idx++;
          sib = sib.previousElementSibling;
        }
        parts.unshift(tag + "[" + idx + "]");
        node = node.parentElement;
      }
      return "/html[1]/body[1]/" + parts.join("/");
    }
    function questionTitleOf(container) {
      let n = container;
      for (let i = 0; i < 6 && n; i++) {
        const title = n.querySelector
          ? n.querySelector(".group-title, .question-title, .question-label, label")
          : null;
        if (title && title.textContent) {
          const t = title.textContent.trim().replace(/\\s+/g, " ");
          if (t.length > 5 && t.length < 200) return t;
        }
        n = n.parentElement;
      }
      return null;
    }
    for (const c of containers) {
      if (out.length >= 12) break;
      const title = questionTitleOf(c);
      const clickables = c.querySelectorAll(
        "label, button, app-radio-button, select option, input[type='radio'], input[type='checkbox']"
      );
      for (const el of clickables) {
        if (out.length >= 12) break;
        const text = (el.textContent || "").trim().replace(/\\s+/g, " ").slice(0, 60);
        if (!text) continue;
        const xp = xpathOf(el);
        const key = xp;
        if (seen.has(key)) continue;
        seen.add(key);
        const q = title ? "[" + title.slice(0, 80) + "] " : "";
        out.push(q + (el.tagName.toLowerCase()) + " '" + text + "' — xpath=" + xp);
      }
    }
    return out;
  })()`;
  const result = await page.evaluate(expr);
  return Array.isArray(result) ? (result as string[]) : [];
}

/**
 * Scan recent capture files for failed submit-endpoint requests and pull
 * out structured field-level errors from the response body. The cascade
 * already saves every captured request to the run's graphql capture dir
 * (see {@link resolveReconRunDir}) with its parsed `responseBody`; this
 * helper reads those files back, filters to captures
 * matching the configured submit pattern with status >= 400, and walks
 * common error-shape conventions (`{ errors: [{ field, message }] }`,
 * `{ validation/fieldErrors: { … } }`, `{ message }`).
 *
 * Returns a short bullet list ready to drop into a prompt; empty string
 * when no failed submit was found. Advisory — never load-bearing.
 */
export function extractSubmitFailureEvidence(
  recentCaptureFilenames: readonly string[],
  /**
   * Hostnames considered "the site's own backend." In strict mode, only 4xx
   * responses from one of these hostnames count as submit failures (we
   * don't surface third-party CDN/analytics 4xx as form-rejection
   * evidence). Replaces the prior `submitEndpointPattern` regex with
   * deterministic hostname equality. Empty list / "any-4xx" mode disables
   * the host filter and returns any 4xx in the window.
   */
  ownBackendHostnames: readonly string[],
  capturesDir: string = resolveReconRunDir().graphqlDir,
  mode: "strict" | "any-4xx" = "strict"
): string {
  if (recentCaptureFilenames.length === 0) return "";
  if (mode === "strict" && ownBackendHostnames.length === 0) return "";
  const records: string[] = [];
  const seen = new Set<string>();
  for (const filename of recentCaptureFilenames.slice(-20)) {
    if (seen.has(filename)) continue;
    seen.add(filename);
    try {
      const path = join(capturesDir, filename);
      const raw = readFileSync(path, "utf8");
      const capture = JSON.parse(raw) as Partial<Capture>;
      if (typeof capture.url !== "string") continue;
      if (mode === "strict") {
        let hostname: string;
        try {
          hostname = new URL(capture.url).hostname;
        } catch {
          continue;
        }
        if (!ownBackendHostnames.includes(hostname)) continue;
      }
      const status = typeof capture.status === "number" ? capture.status : 0;
      if (status < 400) continue;
      const body = capture.responseBody;
      const errors = harvestFieldErrors(body);
      if (errors.length === 0) {
        const fallback =
          typeof body === "string"
            ? body.slice(0, 240)
            : body && typeof body === "object" && "message" in body
              ? String((body as { message?: unknown }).message ?? "").slice(0, 240)
              : body && typeof body === "object" && "error" in body
                ? String((body as { error?: unknown }).error ?? "").slice(0, 240)
                : `(status ${status}; no structured error body)`;
        records.push(`${status} ${capture.url}: ${fallback}`);
        continue;
      }
      for (const e of errors.slice(0, 8)) {
        records.push(`${status} ${capture.url} — ${e}`);
      }
      // K'3: when the submit failure mentions "resume" or "file" or
      // "attachment" AND the request body is multipart form-data but does
      // NOT contain an apply[resume] / file part, surface a hint. This
      // catches the exact pattern from today's smoke (run 1781485435455):
      // 10/10 422 responses said "Resume is blank" while the multipart
      // body had 53 question fields but ZERO resume part — the framework
      // wrapper never registered the file. The hint helps the replan LLM
      // propose "re-upload the resume" instead of cycling on form fields.
      const submitFailureText = errors.join(" ").toLowerCase();
      const mentionsResume =
        submitFailureText.includes("resume") ||
        submitFailureText.includes("file") ||
        submitFailureText.includes("attachment");
      const requestBody = capture.requestPostData;
      if (
        mentionsResume &&
        typeof requestBody === "string" &&
        requestBody.includes("multipart/form-data") === false && // body itself isn't the boundary marker
        !/name="(apply\[resume\]|resume|file|attachment)"/i.test(requestBody) &&
        /name="apply\[/.test(requestBody) // confirm this IS the submit (apply[*] field shape)
      ) {
        records.push(
          `${status} ${capture.url} — HINT: server reports resume/file missing AND the multipart request body had no resume/file part — upload primitive likely failed to register the file in the framework wrapper's state. Re-try the upload step OR find the resume upload widget and use a different fill mechanism.`
        );
      }
    } catch {
      // capture file missing or malformed — skip
    }
  }
  return records.map((r, i) => `${i + 1}. ${r}`).join("\n");
}

/**
 * Surface Google Analytics Measurement Protocol events captured during a
 * step's attempt window. AppCast (and most GA4-instrumented SPAs) emit
 * `view_secondPage`, `view_thankYouPage`, `form_submit` and similar events
 * via `https://www.google-analytics.com/g/collect` — the engine already
 * stores these in `recentCaptures[]` but no code reads them. Without
 * surfacing them the LLM cannot tell that a Submit click actually advanced
 * the SPA to page 2 (because `pre.url === post.url` under SPA routing), nor
 * that the site's own validator (`epn.validationErrorsCount`) reports N
 * unfilled required fields, nor that the application reached the
 * thank-you page (the canonical SUCCESS signal when `/integrated_apply`
 * POSTs are debounced or missed).
 *
 * Returns a numbered evidence list. Empty string when no GA collect
 * captures are present. Advisory — never load-bearing.
 */
export function extractGaEventEvidence(
  recentCaptureFilenames: readonly string[],
  capturesDir: string = resolveReconRunDir().graphqlDir
): string {
  if (recentCaptureFilenames.length === 0) return "";
  const records: string[] = [];
  const seen = new Set<string>();
  for (const filename of recentCaptureFilenames.slice(-20)) {
    if (seen.has(filename)) continue;
    seen.add(filename);
    try {
      const path = join(capturesDir, filename);
      const raw = readFileSync(path, "utf8");
      const capture = JSON.parse(raw) as Partial<Capture>;
      if (typeof capture.url !== "string") continue;
      let url: URL;
      try {
        url = new URL(capture.url);
      } catch {
        continue;
      }
      if (url.hostname !== "www.google-analytics.com") continue;
      if (!url.pathname.startsWith("/g/collect")) continue;
      const params = url.searchParams;
      const eventName = params.get("en");
      if (!eventName) continue;
      const documentLocation = params.get("dl") ?? "";
      const pageTitle = params.get("dt") ?? "";
      const pagePath = ((): string => {
        if (documentLocation.length === 0) return "";
        try {
          return new URL(documentLocation).pathname;
        } catch {
          return documentLocation.slice(0, 80);
        }
      })();
      const detailParts: string[] = [];
      params.forEach((value, key) => {
        if (key.startsWith("epn.")) {
          detailParts.push(`${key.slice(4)}=${value}`);
        } else if (key.startsWith("ep.")) {
          detailParts.push(`${key.slice(3)}=${value}`);
        }
      });
      const detail = detailParts.slice(0, 8).join("; ");
      const locationHint = pagePath || pageTitle || "(no page hint)";
      records.push(
        detail.length > 0
          ? `${eventName} @ ${locationHint} — ${detail}`
          : `${eventName} @ ${locationHint}`
      );
    } catch {
      // capture file missing or malformed — skip
    }
  }
  return records.map((r, i) => `${i + 1}. ${r}`).join("\n");
}

/**
 * Render a long step list as a small head + tail window with an elision
 * marker. Replan prompts grew to ~114KB on the AppCast 331-step flow
 * (verified Fitchburg 2026-06-14 run), causing Sonnet 4.6 to TTFT-stall
 * out at 187s with `APIConnectionTimeoutError: Request timed out.` —
 * the ONLY non-API-quota replan failure across ~30+ historical calls.
 *
 * Empirically, replans at ≤65K chars complete in 3-13s; the 114K case
 * was 15x slower than the worst clean run. Trimming the THREE step
 * blocks (THE ORIGINAL FLOW + STEPS ALREADY SUCCESSFULLY COMPLETED +
 * REMAINING UNEXECUTED STEPS) eliminates ~80% of the bloat without
 * losing replan-relevant context: the LLM's job is to bridge from the
 * failed step back into the remaining tail, not enumerate every step.
 *
 * Configurable head/tail caps so callers can keep relevant boundaries
 * (e.g. completed tail = the last few steps that just succeeded;
 * remaining head = what to bridge into).
 */

/**
 * Outcome of attempting to fill an HTML5 date/time input via the
 * native-setter + dispatch-events workaround. `null` when the target
 * isn't a date/time input (caller falls back to the normal cascade).
 */
export interface Html5DateFillResult {
  /** Whether the value actually landed in the DOM after dispatch. */
  filled: boolean;
  /** What the input's value is now (for verifier signal). */
  postValue: string;
  /** The input's type attribute, for the verifier and prompt context. */
  inputType: string;
}

/**
 * Deterministic fill for HTML5 `<input type="date|time|datetime-local|month|week">`
 * elements. Bypasses Stagehand bug #1249 (locator.fill() and act({method: 'fill'})
 * resolve without error but the value reads back as empty string — confirmed
 * OPEN as of 2026-06-14 in browserbase/stagehand). The fix follows the
 * industry-standard React/Angular controlled-component pattern, also
 * documented as the verified workaround in the Stagehand issue itself.
 *
 * Mechanism:
 *  1. Walk the input value setter on `HTMLInputElement.prototype` to bypass
 *     framework value-setter interception (React, Angular Forms, Vue v-model
 *     all override the setter at instance level — calling the prototype
 *     descriptor's setter restores the native behavior).
 *  2. Dispatch synthesized `input` and `change` events with `bubbles: true`
 *     so the framework's reactivity hooks fire and the form-control state
 *     updates (mark dirty / mark touched / clear ng-pristine).
 *
 * Returns `null` when the xpath doesn't resolve OR the resolved element
 * isn't a date/time input — caller falls back to the normal cascade path.
 *
 * Site-agnostic: the bug + workaround are universal across any tenant
 * using HTML5 date/time inputs.
 */
/**
 * Normalize a date/time string to the format the HTML5 spec requires for
 * the given input type. The HTML5 spec REJECTS programmatic .value writes
 * that don't match the canonical format, regardless of how the browser
 * DISPLAYS the date (locale only affects display formatting).
 *
 * - type="date": YYYY-MM-DD
 * - type="time": HH:MM (or HH:MM:SS)
 * - type="month": YYYY-MM
 * - type="week": YYYY-Www
 * - type="datetime-local": YYYY-MM-DDTHH:MM
 *
 * Today's smoke surfaced this gap: flow text passed "06-14-2026" (MM-DD-YYYY)
 * to a `<input type="date">`. Even if Stagehand had fired the fill correctly,
 * the value would have been silently rejected by the input's setter. K'2's
 * dispatchEvent and Fix I's verifyFillReadback both catch the consequence,
 * but normalizing the value here lets the cascade WORK on first try.
 *
 * Returns null when the input format is unrecognized — caller knows to
 * either pass-through (the value might be correct as-is) or skip.
 */
export function normalizeDateValue(raw: string, inputType: string): string | null {
  const t = inputType.toLowerCase();
  if (t === "date") {
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
    // MM-DD-YYYY or MM/DD/YYYY → YYYY-MM-DD (US convention)
    const usMatch = raw.match(/^(\d{2})[-/](\d{2})[-/](\d{4})$/);
    if (usMatch) return `${usMatch[3]}-${usMatch[1]}-${usMatch[2]}`;
    return null;
  }
  if (t === "month") {
    if (/^\d{4}-\d{2}$/.test(raw)) return raw;
    return null;
  }
  if (t === "week") {
    if (/^\d{4}-W\d{2}$/.test(raw)) return raw;
    return null;
  }
  if (t === "time") {
    if (/^\d{2}:\d{2}(:\d{2})?$/.test(raw)) return raw;
    return null;
  }
  if (t === "datetime-local") {
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(raw)) return raw;
    return null;
  }
  return null;
}

export async function fillHtml5DateTimeInput(
  page: Page,
  xpath: string,
  value: string
): Promise<Html5DateFillResult | null> {
  const HTML5_DATE_TYPES = new Set(["date", "time", "datetime-local", "month", "week"]);
  // K'/H' Change 1: pre-normalize the value before dispatching to the page
  // evaluator. The HTML5 spec rejects programmatic .value writes that don't
  // match the canonical format — see normalizeDateValue TSDoc.
  // We don't yet know the input type until the page.evaluate runs (we'd
  // have to probe it first), so we try BOTH the raw value AND a normalized
  // pass: if raw works, fine; if raw fails (post-value mismatch), the
  // returned filled=false signal tells the caller to retry with a normalized
  // candidate. Today's known fix: try YYYY-MM-DD if raw is MM-DD-YYYY.
  const normalizedDate = normalizeDateValue(value, "date");
  const valueToTry = normalizedDate ?? value;
  const expr = `(() => {
    const xpath = ${JSON.stringify(xpath)};
    const value = ${JSON.stringify(valueToTry)};
    const result = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
    const el = result.singleNodeValue;
    if (!el || el.tagName !== "INPUT") return null;
    const inputType = (el.getAttribute("type") || "text").toLowerCase();
    if (!["date", "time", "datetime-local", "month", "week"].includes(inputType)) {
      return { filled: false, postValue: el.value || "", inputType };
    }
    const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
    if (descriptor && descriptor.set) {
      descriptor.set.call(el, value);
    } else {
      el.value = value;
    }
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    el.dispatchEvent(new Event("blur", { bubbles: true }));
    return { filled: el.value === value, postValue: el.value || "", inputType };
  })()`;
  try {
    const raw = await page.evaluate(expr);
    if (raw === null || typeof raw !== "object") return null;
    const r = raw as { filled?: unknown; postValue?: unknown; inputType?: unknown };
    if (typeof r.inputType !== "string") return null;
    if (!HTML5_DATE_TYPES.has(r.inputType)) return null;
    return {
      filled: r.filled === true,
      postValue: typeof r.postValue === "string" ? r.postValue : "",
      inputType: r.inputType,
    };
  } catch {
    return null;
  }
}

/**
 * Outcome of verifying that a fill action's value actually landed in the
 * target element. Used by the cascade verifier to catch silent-value-rejection
 * cases (HTML5 type validation, framework-controlled-component rejection,
 * masked-input library reformatting).
 */
export interface VerifyFillReadbackResult {
  /** "matched" = element.value === expectedValue; "rejected" = element.value === "" after a non-empty fill; "differs" = element value is non-empty but different (masked / reformatted) */
  outcome: "matched" | "rejected" | "differs";
  /** Actual value read back from the element after the fill. */
  postValue: string;
  /** Tag of the target element (input/textarea/contenteditable). */
  tag: string;
}

/**
 * Read back an element's value after a fill action and compare to the
 * expected value. Catches silent-value-rejection cases that the verifier's
 * existing signals (network/url/dom/htmlDelta/textChanged) miss:
 *  - HTML5 type validation rejecting bad format (date with MM-DD-YYYY,
 *    number with letters, email without @, url without protocol, etc.)
 *  - Framework-controlled-component (Angular [(ngModel)], React useState)
 *    silently rejecting values that don't pass internal validation
 *  - Masked-input libraries (phone, currency, date formatters) reformatting
 *    the value as it's typed
 *
 * Returns null for non-fillable elements (clicks, selects, etc.) — caller
 * knows to skip the check.
 *
 * Site-agnostic: works on any <input>, <textarea>, or [contenteditable]
 * element regardless of framework wrapping. Industry-standard pattern
 * (react-testing-library's `getByDisplayValue` does the same readback).
 */
export async function verifyFillReadback(
  page: Page,
  xpath: string,
  expectedValue: string
): Promise<VerifyFillReadbackResult | null> {
  const expr = `(() => {
    const xpath = ${JSON.stringify(xpath)};
    const expected = ${JSON.stringify(expectedValue)};
    const result = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
    const el = result.singleNodeValue;
    if (!el) return null;
    const tag = el.tagName ? el.tagName.toLowerCase() : "";
    let actual = "";
    if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
      actual = el.value || "";
    } else if (el.isContentEditable) {
      actual = el.textContent || "";
    } else {
      return null;
    }
    let outcome;
    if (actual === expected) outcome = "matched";
    else if (actual === "" && expected !== "") outcome = "rejected";
    else outcome = "differs";
    return { outcome, postValue: actual, tag };
  })()`;
  try {
    const raw = await page.evaluate(expr);
    if (raw === null || typeof raw !== "object") return null;
    const r = raw as { outcome?: unknown; postValue?: unknown; tag?: unknown };
    if (r.outcome !== "matched" && r.outcome !== "rejected" && r.outcome !== "differs") return null;
    return {
      outcome: r.outcome,
      postValue: typeof r.postValue === "string" ? r.postValue : "",
      tag: typeof r.tag === "string" ? r.tag : "",
    };
  } catch {
    return null;
  }
}

/**
 * Pull field-level errors out of an arbitrary JSON response body. Walks a
 * few of the conventional ATS shapes; falls through to `[]` so the caller
 * can decide whether to emit a fallback summary.
 */
function harvestFieldErrors(body: unknown): string[] {
  if (!body || typeof body !== "object") return [];
  const out: string[] = [];
  const rec = body as Record<string, unknown>;
  // Singular `{error: "message"}` shape used by AppCast, Lever, Greenhouse,
  // and any REST API following the {error:string} terse-error convention.
  // Verified on AppCast Encompass-Fitchburg: /integrated_apply 422 body is
  // exactly {"error":"Resume is blank"} — no `errors`, no `message`. Before
  // J', this was caught by neither the array branch below nor the
  // extractSubmitFailureEvidence fallback at line 2028, resulting in
  // `(status 422; no structured error body)` reaching the replan LLM
  // instead of the actual cause.
  if (typeof rec.error === "string" && rec.error.length > 0) {
    out.push(rec.error);
  }
  const errorsArr = rec.errors;
  if (Array.isArray(errorsArr)) {
    for (const e of errorsArr) {
      if (typeof e === "string") out.push(e);
      else if (e && typeof e === "object") {
        const fr = e as Record<string, unknown>;
        const field = typeof fr.field === "string" ? fr.field : null;
        const message =
          typeof fr.message === "string"
            ? fr.message
            : typeof fr.error === "string"
              ? fr.error
              : null;
        if (field && message) out.push(`${field}: ${message}`);
        else if (message) out.push(message);
        else if (field) out.push(field);
      }
    }
  }
  const fieldBags = [rec.validation, rec.fieldErrors, rec.field_errors];
  for (const bag of fieldBags) {
    if (bag && typeof bag === "object" && !Array.isArray(bag)) {
      for (const [field, msg] of Object.entries(bag as Record<string, unknown>)) {
        if (typeof msg === "string") out.push(`${field}: ${msg}`);
        else if (Array.isArray(msg))
          for (const m of msg) if (typeof m === "string") out.push(`${field}: ${m}`);
      }
    }
  }
  return out;
}

/**
 * Stagehand action methods that mutate DOM state without firing a request.
 * Reconcile against `SupportedUnderstudyAction` in
 * `node_modules/@browserbasehq/stagehand/dist/esm/lib/v3/types/private/handlers.js`
 * when bumping Stagehand — new state-class methods must be added here, or the
 * verifier falls back to the network/URL signal and silently false-fails.
 */
const STATE_CLASS_METHODS = new Set([
  "fill",
  "type",
  "selectOption",
  "selectOptionFromDropdown",
  "check",
  "uncheck",
  "setInputFiles",
]);

/**
 * Strip Stagehand's `xpath=` prefix so the body can be composed into a page
 * `evaluate` expression or wrapped in further xpath. Returns null for
 * css/role/text selectors so callers fall back to a non-xpath code path.
 */
function xpathBody(selector: string): string | null {
  return selector.startsWith("xpath=") ? selector.slice("xpath=".length) : null;
}

/** How long the upload primitive waits for a post-setInputFiles network POST. */
const UPLOAD_NETWORK_TIMEOUT_MS = 5_000;
/** Polling interval while waiting for the upload's network signal. */
const UPLOAD_NETWORK_POLL_INTERVAL_MS = 250;
/**
 * How long the upload primitive waits for the async ResumeUpload widget (and its
 * lazily-mounted `<input type=file>`) to render before deciding the input is
 * absent. HCA/Talemetry mounts the MUI/react-dropzone widget ~5s after the
 * wizard lands on the Apply page, so a single probe races that mount and the
 * primitive wrongly falls into the click-to-surface path (or skips). Only
 * reached on `upload:true` steps, so it never slows a page with no upload step.
 */
const UPLOAD_WIDGET_RENDER_INTERVAL_MS = 600;
const UPLOAD_WIDGET_RENDER_ATTEMPTS = 17;
/**
 * URL substrings that mark a POST as an actual resume/attachment upload rather
 * than coincidental traffic (analytics beacons, `/interruption_check`,
 * geocoders). Talemetry posts the resume to an `attachment_upload_url` that
 * matches `/attachment`; the others cover the other ATS upload sinks. Module-
 * level so both the raw-input path and the click-to-surface path share one list.
 */
const UPLOAD_URL_PATTERNS = ["/upload", "/resume", "/file", "/attachment", "/document"] as const;

/** One entry of the recent-network-capture window shared across upload helpers. */
type CaptureMeta = { method: string; status: number; url: string };

/** Fixture shape carried by the upload helpers (never null past the guard). */
type ResumeFixture = { buffer: Buffer; name: string; mimeType: string };

/**
 * Poll the recent-capture window for an upload-related POST after a file has
 * been attached. Extracted from `tryUploadPrimitive` so the raw-input path,
 * the click-to-surface path, and the CDP native-chooser path all verify the
 * same way. Returns true as soon as a non-GET capture whose URL matches
 * {@link UPLOAD_URL_PATTERNS} lands; false if the timeout elapses first.
 */
async function waitForUploadNetworkSignal(params: {
  page: Page;
  fixture: ResumeFixture;
  logger: Logger;
  signalCounter: { n: number };
  recentCaptureMeta: readonly CaptureMeta[];
}): Promise<boolean> {
  const { page, fixture, logger, signalCounter, recentCaptureMeta } = params;
  const networkCountBefore = signalCounter.n;
  const captureMetaCountBefore = recentCaptureMeta.length;
  const startedAt = performance.now();
  while (performance.now() - startedAt < UPLOAD_NETWORK_TIMEOUT_MS) {
    if (signalCounter.n > networkCountBefore) {
      const newCaptures = recentCaptureMeta.slice(captureMetaCountBefore);
      const uploadCapture = newCaptures.find((cap) => {
        if (cap.method === "GET") return false;
        const lowerUrl = cap.url.toLowerCase();
        return UPLOAD_URL_PATTERNS.some((p) => lowerUrl.includes(p));
      });
      if (uploadCapture) {
        logger.info(
          `upload primitive: upload POST detected (name=${fixture.name}, size=${fixture.buffer.length}b, url=${uploadCapture.url.slice(0, 100)})`
        );
        return true;
      }
    }
    await page.waitForTimeout(UPLOAD_NETWORK_POLL_INTERVAL_MS);
  }
  return false;
}

/**
 * True when a control's text/aria-label denotes a resume-upload affordance
 * (the button that surfaces a hidden `<input type=file>` or opens a chooser).
 * Pure + exported for unit tests; the vocabulary is intentionally generic so it
 * benefits any MUI/React/dropzone ATS, not just Talemetry. Rejects negative
 * lookalikes ("upload later", "no file", a bare "submit") so the click-to-
 * surface path never fires a skip/decline/submit control.
 */
export function isUploadAffordanceLabel(label: string): boolean {
  const norm = label.replace(/\s+/g, " ").trim().toLowerCase();
  if (norm.length === 0) return false;
  if (/\b(later|skip|without|remove|delete|cancel)\b/.test(norm)) return false;
  if (/\bno file\b/.test(norm)) return false;
  return /\b(upload|browse|select file|choose file|attach|add (a )?(resume|cv|file)|resume\/cv)\b/.test(
    norm
  );
}

/**
 * Materialize the in-memory resume fixture to a temp file so CDP
 * `DOM.setFileInputFiles` (which requires a filesystem path, unlike
 * Playwright's `locator.setInputFiles`) can reference it. Only used as a
 * fallback when the on-disk fixture path is unavailable. Process-scoped — the
 * recon run is ephemeral, so no explicit cleanup. Returns the absolute path.
 */
export function writeFixtureToTempFile(fixture: { buffer: Buffer; name: string }): string {
  const dir = mkdtempSync(join(tmpdir(), "recon-upload-"));
  const path = join(dir, fixture.name);
  writeFileSync(path, fixture.buffer);
  return path;
}

/**
 * Site-agnostic file-upload primitive that bypasses Stagehand's click-and-act
 * cascade for steps explicitly marked `upload: true` in the flow file.
 *
 * Why this exists: many ATS upload widgets wrap the real `<input type="file">`
 * behind a styled button or dropdown menu (jQuery File Upload + Bootstrap,
 * Material UI menus, custom React popovers). Stagehand's CDP click often
 * fails to trigger the JS handlers that reveal the hidden file input — the
 * verifier correctly reports the click had no observable effect, but no
 * amount of replanning resolves it because no clickable path actually
 * surfaces the input.
 *
 * Dispatch is structural (the caller passes `isUploadStep: boolean` from the
 * flow file's `upload: true` field), NOT text-matched on the step
 * instruction. The pre-N+24 regex-based dispatch (`UPLOAD_RESUME_PATTERN`)
 * false-positived on click steps that mentioned "resume" or "upload" in their
 * descriptions, causing duplicate uploads — see feedback_no_regex_open_sets.
 *
 * Returns `true` if the upload completed; `false` if either the step isn't
 * marked upload OR no file input was found (caller falls through to the
 * existing cascade in that case).
 */
async function tryUploadPrimitive(params: {
  page: Page;
  /** Set from the flow file's `upload: true` field. Replaces the prior regex test. */
  isUploadStep: boolean;
  fixture: { buffer: Buffer; name: string; mimeType: string } | null;
  logger: Logger;
  signalCounter: { n: number };
  /**
   * Tail of the recent-capture-meta window. Used to verify the post-upload
   * network signal is actually an upload-related POST (URL contains
   * /upload, /resume, /file, /attachment OR body has section:"resume"),
   * not coincidental traffic like /interruption_check, /postal_code_geocoder,
   * or analytics beacons. Today's smoke (run 1781485435455) declared upload
   * success on a /interruption_check POST that did NOT register the file
   * in AppCast's framework state — false positive. K'1 catches this by
   * filtering the network signal by URL keyword.
   */
  recentCaptureMeta: readonly { method: string; status: number; url: string }[];
}): Promise<boolean> {
  const { page, isUploadStep, fixture, logger, signalCounter, recentCaptureMeta } = params;
  if (!isUploadStep) {
    return false;
  }
  if (!fixture) {
    return false;
  }
  // Wait (bounded) for the widget to render before deciding the input is absent.
  // The ResumeUpload widget mounts its <input type=file> ~5s after arrival; a
  // single probe races that mount and wrongly drops into click-to-surface. Poll
  // up to the render window (matches `document.querySelectorAll` even when the
  // accessibility tree / a Playwright locator misses a styled-invisible input)
  // and take the proven raw-input path the moment the input exists. The loop
  // exits on the first evaluate when the input is already present, so pages that
  // already rendered it pay nothing.
  let inputCount = 0;
  try {
    inputCount = await pollEnumerate<number>(
      page,
      "document.querySelectorAll('input[type=file]').length",
      (n) => (n ?? 0) > 0,
      { attempts: UPLOAD_WIDGET_RENDER_ATTEMPTS, intervalMs: UPLOAD_WIDGET_RENDER_INTERVAL_MS }
    );
  } catch (err) {
    logger.warn(`upload primitive: file-input probe threw: ${toErrorMessage(err)}`);
    return false;
  }
  if ((inputCount ?? 0) === 0) {
    // Talemetry/MUI and other react-dropzone widgets can render NO <input type=file>
    // at all (a click surfaces it, or a native chooser opens). Try to surface it
    // (click-to-mount or CDP native-chooser interception) before giving up.
    logger.info(
      "upload primitive: no <input type=file> after render wait; attempting click-to-surface"
    );
    const surfaced = await surfaceAndUpload({
      page,
      fixture,
      logger,
      signalCounter,
      recentCaptureMeta,
    });
    if (surfaced) return true;
    logger.info("upload primitive: click-to-surface failed; falling through to cascade");
    return false;
  }
  return attachToSurfacedInput({ page, fixture, logger, signalCounter, recentCaptureMeta });
}

/**
 * Attach the fixture to an already-surfaced `<input type=file>` (raw or freshly
 * mounted after a click) and verify. Extracted verbatim from the original
 * `tryUploadPrimitive` body so the raw-input path and the click-to-surface
 * path share one setInputFiles + framework-change-dispatch + network/DOM verify
 * + drag-drop-fallback implementation.
 */
async function attachToSurfacedInput(params: {
  page: Page;
  fixture: ResumeFixture;
  logger: Logger;
  signalCounter: { n: number };
  recentCaptureMeta: readonly CaptureMeta[];
}): Promise<boolean> {
  const { page, fixture, logger, signalCounter, recentCaptureMeta } = params;
  const target = page.locator("xpath=//input[@type='file']").first();
  try {
    await target.setInputFiles({
      name: fixture.name,
      mimeType: fixture.mimeType,
      buffer: fixture.buffer,
    });
    // Framework-wrapper reactivity: Angular/React/Vue components that wrap
    // <input type="file"> typically register the dropped file via a
    // (change) binding on a parent <uapp-upload> / <app-upload> element,
    // not on the raw input. Playwright's setInputFiles populates
    // input.files[0] AND fires `change` on the input itself, but Angular's
    // ControlValueAccessor binds at the wrapper level — and the wrapper's
    // change handler doesn't observe input.files mutations directly.
    //
    // Verified on AppCast Encompass-Fitchburg today: setInputFiles
    // populated input.files but the subsequent /integrated_apply submit
    // had no `apply[resume]` multipart field — the framework wrapper
    // never registered the file in its internal state. Server returned
    // 10/10 "Resume is blank" 422s.
    //
    // Re-dispatching `change` + `input` on the input bubbles the events
    // up through the DOM tree so any parent component listening for
    // `change`/`input` fires its handler and updates state. We use
    // page.evaluate rather than Playwright's locator.dispatchEvent
    // because Stagehand's Locator subset doesn't expose dispatchEvent.
    // Industry-standard workaround documented across Playwright
    // community. Site-agnostic — works for any tenant with framework-
    // wrapped file inputs.
    await page
      .evaluate(
        "(() => { const els = document.querySelectorAll('input[type=file]'); for (const el of els) { if (el.files && el.files.length > 0) { el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); return true; } } return false; })()"
      )
      .catch((err: unknown) => {
        logger.warn(`upload primitive: change dispatch failed: ${toErrorMessage(err)}`);
      });
  } catch (err) {
    logger.warn(`upload primitive: setInputFiles threw: ${toErrorMessage(err)}`);
    return false;
  }
  // Primary signal: wait for an UPLOAD-RELATED POST to fire. Before K'1, ANY
  // network bump was treated as upload success — but a smoke run captured
  // /interruption_check + analytics POSTs after setInputFiles and falsely
  // declared upload-done. waitForUploadNetworkSignal filters by URL keyword.
  if (
    await waitForUploadNetworkSignal({ page, fixture, logger, signalCounter, recentCaptureMeta })
  ) {
    return true;
  }
  // Fallback: some widgets defer the upload to a separate Save click. For
  // those the DOM still has the attached File — verify there. Widgets that
  // clear input.files on upload trigger (a jQuery File Upload widget)
  // would fail this check, but they should have fired a network call above.
  //
  // Trust boundary: the evaluate expression is a static string literal — no
  // interpolation from external data, no risk of injecting attacker-controlled
  // values into the browser-side JS. Same trust posture as the type-probe
  // expression in verifyDomEffect's click case.
  const attachedLength = await page
    .evaluate(
      "(() => { const els = document.querySelectorAll('input[type=file]'); for (const el of els) { if (el.files && el.files.length > 0) return el.files.length; } return 0; })()"
    )
    .catch(() => 0);
  if (typeof attachedLength !== "number" || attachedLength === 0) {
    logger.warn(
      "upload primitive: no network activity within timeout and no file attached in DOM; attempting drag-drop fallback"
    );
    // K'4: fall back to simulated drag-drop on the most-likely drop zone.
    // Some custom upload widgets (Material Dropzone, react-dropzone, custom
    // <uapp-upload> wrappers) only register files when a `drop` event with
    // a DataTransfer fires on the visible drop area — they don't observe
    // the hidden input's `files[]` mutations even with synthetic `change`
    // dispatches. This is the documented Playwright community workaround.
    const dragDropOk = await simulateDragDropUpload(page, fixture, logger);
    if (dragDropOk) {
      logger.info(
        `upload primitive: drag-drop fallback succeeded (name=${fixture.name}, size=${fixture.buffer.length}b)`
      );
      return true;
    }
    return false;
  }
  logger.info(
    `upload primitive: file attached in DOM after setInputFiles (deferred-upload widget; name=${fixture.name}, filesLength=${attachedLength})`
  );
  return true;
}

/**
 * Recover an upload for widgets that mount NO `<input type=file>` until a button
 * is clicked (Talemetry/MUI `ResumeUpload`, react-dropzone). Ordered cheapest-
 * first: (DZ) a synthetic drag-drop on the dropzone; then, arming CDP native-
 * chooser interception BEFORE any click (a chooser-opening click with no
 * interception blocks the run — the single biggest risk), click the upload
 * affordance and resolve via the first of: (0) an immediate upload POST, (A) a
 * lazily-mounted hidden input, or (B) an intercepted native chooser handled via
 * CDP `DOM.setFileInputFiles`. Interception is always disabled in a finally.
 * Site-agnostic — benefits any MUI/React/chooser ATS. Returns whether a resume
 * was attached.
 */
async function surfaceAndUpload(params: {
  page: Page;
  fixture: ResumeFixture;
  logger: Logger;
  signalCounter: { n: number };
  recentCaptureMeta: readonly CaptureMeta[];
}): Promise<boolean> {
  const { page, fixture, logger, signalCounter, recentCaptureMeta } = params;
  // Render-gate: the input-less strategies below (drag-drop is one-shot, the
  // affordance click resolves what's in the DOM) all race the async widget
  // mount. Wait (bounded, same window as the raw-input probe) for ANY upload
  // target to appear — a dropzone, an upload-affordance button, or an
  // <input type=file> — so every downstream strategy runs against a rendered
  // widget. Static evaluate literal (no interpolation); dropzone list mirrors
  // simulateDragDropUpload and the button matcher mirrors clickUploadAffordance.
  const targetExpr = `(() => {
    const norm = (s) => (s || "").replace(/\\s+/g, " ").trim().toLowerCase();
    const isUpload = (raw) => {
      const t = norm(raw);
      if (!t) return false;
      if (/\\b(later|skip|without|remove|delete|cancel)\\b/.test(t)) return false;
      if (/\\bno file\\b/.test(t)) return false;
      return /\\b(upload|browse|select file|choose file|attach|add (a )?(resume|cv|file)|resume\\/cv)\\b/.test(t);
    };
    if (document.querySelector("input[type=file]")) return { present: true };
    const dz = document.querySelector("[class*='dropzone'],[class*='drop-zone'],[class*='file-drop'],[class*='upload-zone'],[class*='ResumeUpload'],[class*='resumeUpload'],[class*='resume-upload'],uapp-upload,app-upload");
    if (dz) return { present: true };
    const btns = Array.from(document.querySelectorAll("button,[role='button'],a"));
    if (btns.some((el) => isUpload(el.getAttribute("aria-label") || el.textContent || ""))) return { present: true };
    return { present: false };
  })()`;
  const gate = await pollEnumerate<{ present: boolean }>(
    page,
    targetExpr,
    (r) => r?.present === true,
    {
      attempts: UPLOAD_WIDGET_RENDER_ATTEMPTS,
      intervalMs: UPLOAD_WIDGET_RENDER_INTERVAL_MS,
    }
  );
  if (!gate?.present) {
    // Fall through anyway — the strategies below are individually cheap and safe;
    // this just logs that we waited out the full render window without a target.
    logger.info("upload primitive: no upload widget rendered within render window");
  }
  // Strategy DZ: a synthetic drop is cheap, needs no click/chooser, and the
  // widget IS a dropzone. If it registers the file (upload POST or attached
  // input), we're done without touching CDP.
  if (await simulateDragDropUpload(page, fixture, logger)) {
    if (
      await waitForUploadNetworkSignal({ page, fixture, logger, signalCounter, recentCaptureMeta })
    ) {
      logger.info("upload primitive: resolved via drag-drop onto dropzone");
      return true;
    }
  }
  const session = page.getSessionForFrame(page.mainFrameId());
  let chooserBackendNodeId: number | null = null;
  const onChooser = (paramsIn?: object): void => {
    const p = paramsIn as { backendNodeId?: number } | undefined;
    if (p && typeof p.backendNodeId === "number") chooserBackendNodeId = p.backendNodeId;
  };
  // ARM native-chooser interception BEFORE the click. Page.fileChooserOpened
  // only carries a backendNodeId while interception is enabled; without it a
  // chooser-opening click would pop a real OS dialog and hang the run.
  await page.sendCDP("Page.enable").catch(() => {});
  await page
    .sendCDP("Page.setInterceptFileChooserDialog", { enabled: true })
    .catch((e: unknown) =>
      logger.warn(`upload primitive: chooser-intercept arm failed: ${toErrorMessage(e)}`)
    );
  session.on("Page.fileChooserOpened", onChooser);
  try {
    if (!(await clickUploadAffordance(page, logger))) return false;
    // Strategy 0: some MUI widgets XHR straight to attachment_upload_url on
    // click, no chooser, no input.
    if (
      await waitForUploadNetworkSignal({ page, fixture, logger, signalCounter, recentCaptureMeta })
    ) {
      logger.info("upload primitive: resolved via click → immediate upload POST");
      return true;
    }
    // Strategy A: the click lazily mounted a hidden <input type=file>.
    const appeared = await pollEnumerate<number>(
      page,
      "document.querySelectorAll('input[type=file]').length",
      (n) => (n ?? 0) > 0
    );
    if ((appeared ?? 0) > 0) {
      logger.info("upload primitive: click surfaced a hidden <input type=file>");
      if (
        await attachToSurfacedInput({ page, fixture, logger, signalCounter, recentCaptureMeta })
      ) {
        return true;
      }
    }
    // Strategy B: the click opened a native chooser we intercepted.
    if (chooserBackendNodeId !== null) {
      logger.info(
        `upload primitive: native file chooser intercepted (backendNodeId=${chooserBackendNodeId}); setting files via CDP`
      );
      return setFilesViaCdp({
        page,
        session,
        backendNodeId: chooserBackendNodeId,
        fixture,
        logger,
        signalCounter,
        recentCaptureMeta,
      });
    }
    return false;
  } finally {
    session.off("Page.fileChooserOpened", onChooser);
    await page.sendCDP("Page.setInterceptFileChooserDialog", { enabled: false }).catch(() => {});
  }
}

/**
 * Locate and click the resume-upload affordance in the page DOM. Uses a DOM
 * enumerate (NOT Stagehand observe, which returns [] for these MUI buttons)
 * over `button`/`[role=button]`/`a`, matching text/aria-label via the same
 * upload vocabulary as {@link isUploadAffordanceLabel}, preferring controls
 * scoped inside an attachment/upload/resume container. Returns whether a
 * matching control was clicked.
 */
async function clickUploadAffordance(page: Page, logger: Logger): Promise<boolean> {
  // The browser-side matcher mirrors isUploadAffordanceLabel; kept as a literal
  // so the enumerate is a static string (same trust posture as the other
  // primitives). No external interpolation.
  const expr = `(() => {
    const norm = (s) => (s || "").replace(/\\s+/g, " ").trim().toLowerCase();
    const isUpload = (raw) => {
      const t = norm(raw);
      if (!t) return false;
      if (/\\b(later|skip|without|remove|delete|cancel)\\b/.test(t)) return false;
      if (/\\bno file\\b/.test(t)) return false;
      return /\\b(upload|browse|select file|choose file|attach|add (a )?(resume|cv|file)|resume\\/cv)\\b/.test(t);
    };
    const els = Array.from(document.querySelectorAll("button,[role='button'],a"));
    const scoped = (el) => !!el.closest("[class*='ttachment'],[class*='pload'],[class*='esume']");
    const matches = els.filter((el) => isUpload(el.getAttribute("aria-label") || el.textContent || ""));
    if (matches.length === 0) return { clicked: false };
    const chosen = matches.find(scoped) || matches[0];
    chosen.click();
    return { clicked: true, text: norm(chosen.getAttribute("aria-label") || chosen.textContent || "").slice(0, 50) };
  })()`;
  try {
    const result = (await pollEnumerate<{ clicked: boolean; text?: string }>(
      page,
      expr,
      (r) => r?.clicked === true
    )) ?? { clicked: false };
    if (result.clicked) {
      logger.info(`upload primitive: clicked upload affordance "${result.text ?? ""}"`);
      return true;
    }
    logger.info("upload primitive: no upload affordance button found in DOM");
    return false;
  } catch (err) {
    logger.warn(`upload primitive: affordance click threw: ${toErrorMessage(err)}`);
    return false;
  }
}

/**
 * Complete a native-chooser upload the recon intercepted via CDP. CDP's
 * `DOM.setFileInputFiles` takes filesystem PATHS (not buffers), so it uses the
 * on-disk fixture path when available and otherwise writes the buffer to a temp
 * file. Targets the intercepted input by `backendNodeId`, then verifies via the
 * shared upload-network signal.
 */
async function setFilesViaCdp(params: {
  page: Page;
  session: ReturnType<Page["getSessionForFrame"]>;
  backendNodeId: number;
  fixture: ResumeFixture;
  logger: Logger;
  signalCounter: { n: number };
  recentCaptureMeta: readonly CaptureMeta[];
}): Promise<boolean> {
  const { page, session, backendNodeId, fixture, logger, signalCounter, recentCaptureMeta } =
    params;
  // CDP needs a filesystem path; the fixture is an in-memory buffer. Write it
  // to a temp file (tiny — a few KB) so the path is always valid regardless of
  // where the recon loaded the fixture from.
  const path = writeFixtureToTempFile(fixture);
  try {
    await session.send("DOM.setFileInputFiles", { files: [path], backendNodeId });
  } catch (err) {
    logger.warn(`upload primitive: CDP setFileInputFiles threw: ${toErrorMessage(err)}`);
    return false;
  }
  if (
    await waitForUploadNetworkSignal({ page, fixture, logger, signalCounter, recentCaptureMeta })
  ) {
    return true;
  }
  // CDP-set files don't surface via input.files, so the DOM-attached-files
  // check can't confirm; treat a filename chip appearing in the DOM as the
  // secondary success signal (the MUI widget renders the chosen filename).
  const nameShown = await page
    .evaluate(
      `document.body && document.body.textContent && document.body.textContent.indexOf(${JSON.stringify(fixture.name)}) !== -1`
    )
    .catch(() => false);
  if (nameShown === true) {
    logger.info(`upload primitive: CDP upload confirmed by filename in DOM (name=${fixture.name})`);
    return true;
  }
  return false;
}

/**
 * Parse a select/dropdown flow step into the option to choose and (when
 * present) the question label that scopes which dropdown it targets.
 *
 * Why: HCA/Talemetry render dropdowns as `MuiNativeSelect` native `<select>`
 * with `tabindex="-1"` — removed from the accessibility tree, so Stagehand
 * observe returns `[]` and the cascade can never select an option. The select
 * primitive answers these directly from the DOM, but needs the target option
 * text (and, to disambiguate multiple dropdowns on one page, the question
 * label) extracted from the human-readable step.
 *
 * Recognizes the flow's conventional phrasings, all quoted:
 *   "select 'Yes'", "select or check 'BLS'",
 *   "for 'What is your highest level…?' select 'BSN completed'",
 *   "select 'Texas' in the State/Region dropdown".
 * Returns null when the step is not a single-dropdown select (e.g. generic
 * "for any remaining question…" catch-alls, or radio/checkbox-only steps) so
 * the caller falls through to the normal cascade.
 */
export function parseSelectStep(
  instruction: string
): { option: string; questionLabel: string | null } | null {
  const lower = instruction.toLowerCase();
  // Must look like a dropdown selection, not a radio/checkbox click. "select
  // or check" is allowed (some option lists render as either). A bare
  // "click the 'Yes' answer" is a radio and handled by the cascade.
  const mentionsSelect = /\bselect(\s+or\s+check)?\b/.test(lower);
  if (!mentionsSelect) return null;
  // Catch-all steps ("for any remaining…") have no concrete single target.
  if (/\bany\s+remaining\b/.test(lower)) return null;
  // biome-ignore lint/style/noNonNullAssertion: capture group 1 is required by the pattern, so it is present on every match
  const quoted = [...instruction.matchAll(/'([^']+)'/g)].map((m) => m[1]!);
  if (quoted.length === 0) return null;
  // The OPTION is the quoted string immediately following the word "select".
  const selMatch = instruction.match(/\bselect(?:\s+or\s+check)?\s+'([^']+)'/i);
  if (!selMatch) return null;
  // biome-ignore lint/style/noNonNullAssertion: guarded by the !selMatch early-return; group 1 is required by the pattern
  const option = selMatch[1]!.trim();
  // The QUESTION LABEL, when present, is a DIFFERENT quoted string — the one
  // introduced by "for '…'" or "in the '…' dropdown". Pick the first quoted
  // string that is not the option.
  const questionLabel = quoted.find((q) => q.trim() !== option)?.trim() ?? null;
  return { option, questionLabel };
}

/**
 * Parse a single-choice RADIO flow step into the option to click and (when
 * present) the question label that scopes which radio group it targets.
 *
 * Why this exists (sibling of `parseSelectStep`): `parseSelectStep`
 * deliberately excludes bare radio steps ("a bare 'click the Yes answer' is a
 * radio"), leaving radios with no DOM-direct primitive — they fall to the
 * observe cascade, which on HCA/Talemetry's MUI radio markup resolves the step
 * to a wrapper `<div>`/`<span>` (not the `<input type=radio>`) and commits via
 * a bare `el.click()` that never triggers React's controlled-state `onChange`.
 * The field stays `Mui-error` "required", Next no-ops, and the wizard walls at
 * Step 2 of 10. `tryRadioPrimitive` needs the option/question text extracted
 * from the human-readable step to answer the radio group directly.
 *
 * Recognizes the flow's conventional radio phrasings, all quoted:
 *   "Click the 'Yes' answer for the question 'Are you at least 18 years…?'",
 *   "Click the 'No' answer for the question about requiring visa sponsorship…",
 *   "Click the 'Yes' radio button for the 'Are you currently licensed…' question".
 * Returns null for select/checkbox steps (`select`/`check` verbs — those route
 * to the select/checkbox primitives) and for the "for any remaining…" catch-all.
 */
export function parseRadioStep(
  instruction: string
): { option: string; questionLabel: string | null } | null {
  const lower = instruction.toLowerCase();
  // Select/checkbox steps belong to trySelect/tryCheckbox; skip them here so a
  // single step never resolves through two primitives.
  if (/\bselect(\s+or\s+check)?\b/.test(lower)) return null;
  // Must be a radio-style click: "click the 'X' answer/radio…".
  if (!/\bclick\b/.test(lower)) return null;
  if (!/\b(answer|radio)\b/.test(lower)) return null;
  // Catch-all steps ("for any remaining…") have no concrete single target.
  if (/\bany\s+remaining\b/.test(lower)) return null;
  // biome-ignore lint/style/noNonNullAssertion: capture group 1 is required by the pattern, so it is present on every match
  const quoted = [...instruction.matchAll(/'([^']+)'/g)].map((m) => m[1]!);
  if (quoted.length === 0) return null;
  // The OPTION is the quoted string immediately after "click the".
  const optMatch = instruction.match(/\bclick\s+the\s+'([^']+)'/i);
  if (!optMatch) return null;
  // biome-ignore lint/style/noNonNullAssertion: guarded by the !optMatch early-return; group 1 is required by the pattern
  const option = optMatch[1]!.trim();
  // The QUESTION LABEL, when present, is a DIFFERENT quoted string — the one
  // introduced by "for the question '…'" / "for the '…' question". Some steps
  // phrase the question un-quoted ("…about requiring visa sponsorship"); in
  // that case there is no second quoted string and questionLabel stays null,
  // which the primitive handles via LLM group-matching.
  const questionLabel = quoted.find((q) => q.trim() !== option)?.trim() ?? null;
  return { option, questionLabel };
}

/** Max settle-retry attempts for a primitive's DOM enumerate (see `pollEnumerate`). */
const PRIMITIVE_ENUMERATE_ATTEMPTS = 5;
/** Delay between settle-retry attempts. Total cap ≈ ATTEMPTS × this. */
const PRIMITIVE_ENUMERATE_RETRY_MS = 600;

/**
 * Run a primitive's read-only DOM enumerate with a bounded settle-retry. SPA
 * wizards (Talemetry) frequently render the target widget a beat AFTER the flow
 * step fires — the first evaluate sees an empty page, so the primitive would
 * give up even though the widget appears moments later. Re-run the enumerate up
 * to `PRIMITIVE_ENUMERATE_ATTEMPTS` times, waiting `PRIMITIVE_ENUMERATE_RETRY_MS`
 * between tries, returning as soon as `isPresent(result)` is true; otherwise
 * return the last (absent) result so the caller falls through to the cascade
 * unchanged. Only wraps the ENUMERATE (which is read-only when nothing matches);
 * the apply/mutate paths are untouched. Site-agnostic render-lag mitigation.
 *
 * `opts` overrides the attempt count / interval for callers that need a longer
 * window (the resume-upload widget can take 5s+ to mount); omitting it keeps the
 * default ~3s window so every existing caller is unchanged.
 */
export async function pollEnumerate<T>(
  page: Page,
  expr: string,
  isPresent: (result: T) => boolean,
  opts?: { attempts?: number; intervalMs?: number }
): Promise<T> {
  const attempts = opts?.attempts ?? PRIMITIVE_ENUMERATE_ATTEMPTS;
  const intervalMs = opts?.intervalMs ?? PRIMITIVE_ENUMERATE_RETRY_MS;
  let result = (await page.evaluate(expr)) as T;
  for (let attempt = 1; attempt < attempts && !isPresent(result); attempt++) {
    await page.waitForTimeout(intervalMs);
    result = (await page.evaluate(expr)) as T;
  }
  return result;
}

/**
 * Bounded poll for the real advance-transition POST to appear in this step's
 * capture window. The verifiers snapshot once after `STEP_PAUSE_MS`, but the
 * genuine `TransitionWorklet(type="next")` POST can land hundreds of ms to 2s+
 * AFTER that snapshot (HCA fires a fast `WorkletPayload` autosave first). A
 * one-shot check false-negatives the advance, retries the click, and the stale
 * retry fires a `back` — a next→back oscillation that never leaves the page.
 * Re-check {@link windowHasAdvanceTransition} every `intervalMs` until it matches
 * or `timeoutMs` elapses; returns true the moment a real advance lands.
 *
 * Each poll iteration re-scans `capturesDir` for files indexed after `preIdx`
 * (via {@link capturesAfterIndex}), so a POST that lands on disk AFTER the first
 * check enters the scanned window on the next iteration. `preIdx` scopes the
 * window to THIS step, so a later step's transition can't satisfy it.
 */
export async function waitForTransitionBody(params: {
  page: Page;
  preIdx: number;
  advanceTransitionBodyPattern: string | null;
  timeoutMs: number;
  intervalMs: number;
  capturesDir?: string;
}): Promise<boolean> {
  const { page, preIdx, advanceTransitionBodyPattern, timeoutMs, intervalMs } = params;
  if (!advanceTransitionBodyPattern) return false;
  const check = (): boolean =>
    windowHasAdvanceTransition({
      preIdx,
      advanceTransitionBodyPattern,
      capturesDir: params.capturesDir,
    });
  if (check()) return true;
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    await page.waitForTimeout(intervalMs);
    if (check()) return true;
  }
  return false;
}

/**
 * Site-agnostic select primitive: answer a native `<select>` dropdown by
 * directly setting its value in the DOM, bypassing Stagehand observe/act.
 *
 * Why this exists (parallels `tryUploadPrimitive`): Talemetry/MUI dropdowns are
 * `MuiNativeSelect` native `<select>` elements carrying `tabindex="-1"`, which
 * removes them from the accessibility tree. Stagehand observe returns `[]` for
 * them, so the cascade's `selectOption` (which needs a resolved locator) never
 * fires — the required question stays unanswered, "Next" no-ops on client-side
 * validation, and every run caps at the questions pages. This primitive finds
 * the `<select>` by raw DOM (including tabindex=-1), matches the requested
 * option by text/value/normalized label, and sets it via the React-safe native
 * value setter + bubbling `change` (the same technique the codebase already
 * uses for text inputs and file inputs), so React/MUI's value tracker
 * registers the change.
 *
 * When the flow's hardcoded option text doesn't exist in THIS requisition's
 * option list (per-req screening-question variance — e.g. an ER answer on a
 * Cardiac job), it enumerates the target select's real options and asks an LLM
 * judge to pick the best available one, then applies that. Deterministic
 * matches never invoke the LLM (fast path); the LLM fires only on a
 * present-but-unmatched select. A page with no `<select>` (radio group /
 * absent) falls through to the cascade unchanged.
 *
 * Returns true when an option was selected (deterministic or LLM) and its
 * value set (cascade is skipped); false when the step isn't a select, there's
 * no select on the page, or no option fits (fall through to the cascade).
 */
/**
 * Set a native `<select>` (by DOM index) to `value`, then settle and read back
 * whether the field is STILL invalid. Split out from the enumerate expr so the
 * validation tick can be awaited: MUI `NativeSelect` re-runs required-validation
 * a beat after the synthetic `change`, so an immediate `sel.value === value`
 * readback passes even when the FormControl still flags the field required (and
 * a later worklet re-render then wipes the DOM-only value — the exact HCA
 * Job-Related failure). Returns `stillInvalid` so {@link trySelectPrimitive} can
 * refuse to claim success on an uncommitted select, routing to the cascade/replan
 * instead of silently advancing. Walks ≤6 ancestors for the invalid marker, same
 * as the radio/checkbox primitives.
 */
async function applySelectValue(
  page: Page,
  selIdx: number,
  value: string
): Promise<{ ok: boolean; stillInvalid: boolean }> {
  const setExpr = `((selIdx, value) => {
    const sel = Array.from(document.querySelectorAll("select"))[selIdx];
    if (!sel) return { ok: false };
    const desc = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value");
    if (desc && desc.set) { desc.set.call(sel, value); } else { sel.value = value; }
    sel.dispatchEvent(new Event("input", { bubbles: true }));
    sel.dispatchEvent(new Event("change", { bubbles: true }));
    sel.dispatchEvent(new Event("blur", { bubbles: true }));
    return { ok: sel.value === value };
  })(${JSON.stringify(selIdx)}, ${JSON.stringify(value)})`;
  const setResult = (await page.evaluate(setExpr)) as { ok: boolean };
  if (!setResult?.ok) return { ok: false, stillInvalid: false };
  await page.waitForTimeout(SELECT_SETTLE_MS);
  const invalidExpr = `((selIdx) => {
    const isInvalid = ${INVALID_MARKER_EL_EXPR};
    const sel = Array.from(document.querySelectorAll("select"))[selIdx];
    if (!sel) return false;
    let node = sel;
    for (let depth = 0; depth < 6 && node; depth++) {
      if (node.getAttribute && isInvalid(node)) return true;
      node = node.parentElement;
    }
    return false;
  })(${JSON.stringify(selIdx)})`;
  const stillInvalid = (await page.evaluate(invalidExpr).catch(() => false)) as boolean;
  return { ok: true, stillInvalid };
}

async function trySelectPrimitive(params: {
  page: Page;
  instruction: string;
  logger: Logger;
  anthropic: Anthropic | null;
  captureFn?: JudgeCaptureFn;
}): Promise<boolean> {
  const { page, instruction, logger, anthropic, captureFn } = params;
  const parsed = parseSelectStep(instruction);
  if (!parsed) return false;
  const { option, questionLabel } = parsed;
  const optLabel = `option "${option.slice(0, 40)}"${questionLabel ? `, question "${questionLabel.slice(0, 40)}"` : ""}`;
  // Phase 1 (browser, no mutation): find the target select — the one whose
  // nearby text matches the question label (or, when no label, any select).
  // Try a deterministic option match first; if it hits, apply immediately (no
  // LLM). Otherwise return the target select's real option list so the Node
  // side can ask the LLM to pick the best available option (per-req variance:
  // the flow's hardcoded answer may not exist in THIS requisition's options).
  //
  // Trust boundary: option/questionLabel come from the committed flow file
  // (operator-authored); JSON.stringify anyway so quotes can't break the expr.
  const enumerateExpr = `((option) => {
    const norm = (s) => (s || "").replace(/\\s+/g, " ").trim().toLowerCase();
    const wantOpt = norm(option);
    // All native selects, INCLUDING tabindex=-1 (MuiNativeSelect) which the
    // a11y tree — and therefore Stagehand observe — never surfaces.
    const selects = Array.from(document.querySelectorAll("select"));
    if (selects.length === 0) return { selectPresent: false };
    // FAST PATH — deterministic option match: exactly one select has an option
    // matching the flow's answer text. Unambiguous (the option text itself
    // identifies the dropdown), so no LLM needed. Requires a UNIQUE match to
    // avoid picking the wrong dropdown when two share an option (e.g. "Yes").
    // NOTE: detection only — the actual value-set happens in Node (applySelectValue)
    // so it can settle + read back the invalid marker asynchronously.
    let detMatches = [];
    for (let i = 0; i < selects.length; i++) {
      const opts = Array.from(selects[i].options || []);
      const m = opts.find((o) => norm(o.textContent) === wantOpt || norm(o.value) === wantOpt);
      if (m) detMatches.push({ selIdx: i, value: m.value, text: m.textContent });
    }
    if (detMatches.length === 1) {
      return { selectPresent: true, detMatch: detMatches[0] };
    }
    // LLM PATH — return every UNFILLED select (placeholder / empty value) with
    // its label + real options, in DOM order (index-aligned). The LLM decides
    // WHICH dropdown answers the question AND which option — offloading the
    // brittle label→select matching that string heuristics get wrong.
    const selLabelText = (sel) => {
      const parts = [];
      if (sel.id) {
        try {
          const esc = (window.CSS && CSS.escape) ? CSS.escape(sel.id) : sel.id;
          const lf = document.querySelector('label[for="' + esc + '"]');
          if (lf) parts.push(lf.textContent);
        } catch (e) {}
      }
      const alb = sel.getAttribute("aria-labelledby");
      if (alb) for (const id of alb.split(/\\s+/)) { const el = document.getElementById(id); if (el) parts.push(el.textContent); }
      const al = sel.getAttribute("aria-label");
      if (al) parts.push(al);
      // Fallback: nearest small ancestor's text (question-item wrapper).
      if (parts.length === 0) {
        let node = sel.parentElement;
        for (let d = 0; d < 5 && node; d++) {
          if (node.querySelectorAll("select,input,textarea").length > 2) break;
          const t = (node.textContent || "").trim();
          if (t) { parts.push(t); break; }
          node = node.parentElement;
        }
      }
      return (parts.join(" ") || "").replace(/\\s+/g, " ").trim().slice(0, 120);
    };
    const isUnfilled = (sel) => {
      const so = sel.selectedOptions && sel.selectedOptions[0];
      return !sel.value || sel.value === "" || (so && so.disabled);
    };
    const candidates = [];
    for (let i = 0; i < selects.length; i++) {
      const sel = selects[i];
      if (!isUnfilled(sel)) continue;
      const options = Array.from(sel.options || [])
        .filter((o) => !o.disabled && (o.value || (o.textContent || "").trim()))
        .map((o) => ({ text: (o.textContent || "").replace(/\\s+/g, " ").trim(), value: o.value }));
      if (options.length > 0) candidates.push({ selIdx: i, label: selLabelText(sel), options });
    }
    if (candidates.length === 0) return { selectPresent: true, candidates: [] };
    return { selectPresent: true, candidates };
  })(${JSON.stringify(option)})`;
  try {
    // Settle-retry: the <select> may render a beat after the step fires (SPA
    // render-lag); poll until it appears or the cap is hit.
    const enumResult = await pollEnumerate<{
      selectPresent: boolean;
      detMatch?: { selIdx: number; value: string; text: string };
      candidates?: { selIdx: number; label: string; options: { text: string; value: string }[] }[];
    }>(page, enumerateExpr, (r) => r?.selectPresent === true);
    // No <select> on the page at all (e.g. the question is a radio group) —
    // fall through to the cascade unchanged; the LLM picker can't help here.
    if (!enumResult?.selectPresent) {
      logger.info(
        `select primitive: no <select> on page for ${optLabel}; falling through to cascade`
      );
      return false;
    }
    // Deterministic unique-option match: set it, settle, and confirm it committed
    // (cleared the required/invalid marker). A set that doesn't clear the marker
    // is uncommitted (a later worklet re-render will wipe it) — refuse to claim
    // success so the cascade/replan can retry rather than silently advancing.
    if (enumResult.detMatch) {
      const { ok, stillInvalid } = await applySelectValue(
        page,
        enumResult.detMatch.selIdx,
        enumResult.detMatch.value
      );
      if (ok && !stillInvalid) {
        logger.info(
          `select primitive: set dropdown to "${enumResult.detMatch.text.trim().slice(0, 40)}" (${optLabel})`
        );
        return true;
      }
      logger.info(
        `select primitive: dropdown value for ${optLabel} did not commit (ok=${ok} stillInvalid=${stillInvalid}); falling through to cascade`
      );
      return false;
    }
    const candidates = enumResult.candidates ?? [];
    if (anthropic === null || candidates.length === 0) {
      logger.info(
        `select primitive: no unique option match for ${optLabel}${anthropic === null ? " (no LLM client)" : ""}; falling through to cascade`
      );
      return false;
    }
    // LLM picks WHICH dropdown answers the question and which option in it.
    const verdict = await judgeSelectOptionWithLLM({
      client: anthropic,
      input: {
        questionLabel,
        desiredHint: option,
        candidates: candidates.map((c) => ({
          label: c.label || null,
          options: c.options.map((o) => o.text),
        })),
      },
      captureFn,
    });
    if (!verdict || verdict.selectIndex === null || verdict.optionIndex === null) {
      logger.info(
        `select primitive: LLM found no matching dropdown for ${optLabel}${verdict ? ` (${verdict.reason})` : ""}; falling through to cascade`
      );
      return false;
    }
    // biome-ignore lint/style/noNonNullAssertion: guarded above by the verdict.selectIndex === null early-return
    const chosenCandidate = candidates[verdict.selectIndex]!;
    // biome-ignore lint/style/noNonNullAssertion: guarded above by the verdict.optionIndex === null early-return
    const chosenOption = chosenCandidate.options[verdict.optionIndex]!;
    // Apply pass (set + settle + invalid-readback): set the chosen select by its
    // ORIGINAL DOM index, then confirm it committed (cleared the invalid marker),
    // same as the fast path.
    const { ok, stillInvalid } = await applySelectValue(
      page,
      chosenCandidate.selIdx,
      chosenOption.value
    );
    if (ok && !stillInvalid) {
      logger.info(
        `select primitive: LLM chose "${chosenOption.text.slice(0, 40)}" for ${optLabel} (${verdict.reason.slice(0, 60)})`
      );
      return true;
    }
    logger.info(
      `select primitive: LLM-chosen value for ${optLabel} did not commit (ok=${ok} stillInvalid=${stillInvalid}); falling through`
    );
    return false;
  } catch (err) {
    logger.warn(`select primitive: evaluate threw: ${toErrorMessage(err)}; falling through`);
    return false;
  }
}

/** Option texts that answer a required select without volunteering info — used
 * only as a LAST resort when a required question offers nothing better. */
const DECLINE_OPTION_MARKERS = [
  "prefer not",
  "decline",
  "do not wish",
  "don't wish",
  "not to answer",
  "not to disclose",
  "withhold",
  "choose not",
];

/**
 * Pick an option to satisfy a REQUIRED select on a catch-all step, from the
 * select's option TEXTS (placeholder already excluded upstream). Policy: take
 * the first non-decline option (a plausible substantive answer — the operator
 * accepts LLM-plausible answers reaching HCA prod); fall back to the first
 * option only if every option is a decline/placeholder. Returns null when there
 * is nothing selectable. Pure + exported so the policy is unit-testable; the LLM
 * path ({@link judgeSelectOptionWithLLM}) is preferred when a client is present,
 * this is the deterministic fallback.
 */
export function chooseRequiredSelectOption(options: readonly string[]): string | null {
  const cleaned = options.map((o) => o.trim()).filter((o) => o.length > 0);
  if (cleaned.length === 0) return null;
  const isDecline = (t: string): boolean => {
    const low = t.toLowerCase();
    return DECLINE_OPTION_MARKERS.some((m) => low.includes(m));
  };
  return cleaned.find((o) => !isDecline(o)) ?? cleaned[0] ?? null;
}

/**
 * Catch-all primitive: fill EVERY required-but-empty native `<select>` on the
 * page, regardless of whether it shows a visible invalid marker.
 *
 * Why this exists: a required MuiNativeSelect (`tabindex=-1`, so invisible to
 * Stagehand observe) can block the worklet's server-side advance while the flow
 * has no step targeting it — requisition-specific specialty questions vary per
 * posting ("years in Med Surg Services" / "…Emergency Room…" / ICU / OR …), so
 * per-question flow steps can't cover them. `trySelectPrimitive` only handles a
 * single concrete "select 'X'" target and `parseSelectStep` deliberately returns
 * null for the catch-all step, so those unmarked required selects reach only the
 * cascade, which can't see them. This runs ONLY on a catch-all step ("for any
 * remaining … question") and fills each required-empty select with a sensible
 * option (LLM-picked when a client is present, else {@link chooseRequiredSelectOption}),
 * committing through {@link applySelectValue} (settle + invalid-marker readback).
 * No-op (returns false → cascade) when the step isn't a catch-all or no
 * required-empty select is present, so radio/checkbox catch-alls are unaffected.
 */
async function tryFillRequiredSelectsPrimitive(params: {
  page: Page;
  instruction: string;
  logger: Logger;
  anthropic: Anthropic | null;
  captureFn?: JudgeCaptureFn;
}): Promise<boolean> {
  const { page, instruction, logger, anthropic, captureFn } = params;
  // Gate: catch-all steps only. parseSelectStep returns null for these (its
  // `any remaining` guard), so this never collides with the single-target
  // trySelectPrimitive that owns concrete "select 'X'" steps.
  if (!/\bany\s+remaining\b/i.test(instruction) || parseSelectStep(instruction) !== null) {
    return false;
  }
  // Enumerate required-and-empty selects with their labels + real options.
  // Required detection: the HTML `required` attr OR aria-required OR aria-invalid
  // (MUI marks NativeSelect via any of these). Reuses the isUnfilled / selLabelText
  // shape from trySelectPrimitive.
  const enumerateExpr = `(() => {
    const selects = Array.from(document.querySelectorAll("select"));
    if (selects.length === 0) return { candidates: [] };
    const selLabelText = (sel) => {
      const parts = [];
      if (sel.id) {
        try {
          const esc = (window.CSS && CSS.escape) ? CSS.escape(sel.id) : sel.id;
          const lf = document.querySelector('label[for="' + esc + '"]');
          if (lf) parts.push(lf.textContent);
        } catch (e) {}
      }
      const alb = sel.getAttribute("aria-labelledby");
      if (alb) for (const id of alb.split(/\\s+/)) { const el = document.getElementById(id); if (el) parts.push(el.textContent); }
      const al = sel.getAttribute("aria-label");
      if (al) parts.push(al);
      if (parts.length === 0) {
        let node = sel.parentElement;
        for (let d = 0; d < 5 && node; d++) {
          if (node.querySelectorAll("select,input,textarea").length > 2) break;
          const t = (node.textContent || "").trim();
          if (t) { parts.push(t); break; }
          node = node.parentElement;
        }
      }
      return (parts.join(" ") || "").replace(/\\s+/g, " ").trim().slice(0, 120);
    };
    const isUnfilled = (sel) => {
      const so = sel.selectedOptions && sel.selectedOptions[0];
      return !sel.value || sel.value === "" || (so && so.disabled);
    };
    const isRequired = (sel) =>
      sel.required === true ||
      sel.getAttribute("aria-required") === "true" ||
      sel.getAttribute("aria-invalid") === "true";
    const candidates = [];
    for (let i = 0; i < selects.length; i++) {
      const sel = selects[i];
      if (!isRequired(sel) || !isUnfilled(sel)) continue;
      const options = Array.from(sel.options || [])
        .filter((o) => !o.disabled && (o.value || (o.textContent || "").trim()))
        .map((o) => ({ text: (o.textContent || "").replace(/\\s+/g, " ").trim(), value: o.value }));
      if (options.length > 0) candidates.push({ selIdx: i, label: selLabelText(sel), options });
    }
    return { candidates };
  })()`;
  try {
    const enumResult = await pollEnumerate<{
      candidates: { selIdx: number; label: string; options: { text: string; value: string }[] }[];
    }>(page, enumerateExpr, (r) => Array.isArray(r?.candidates));
    const candidates = enumResult?.candidates ?? [];
    if (candidates.length === 0) return false;
    logger.info(`required-select primitive: ${candidates.length} required-empty select(s) to fill`);
    let allCommitted = true;
    for (const cand of candidates) {
      // Prefer an LLM pick (plausible, non-decline); fall back to the pure policy.
      const llmVerdict =
        anthropic !== null
          ? await judgeSelectOptionWithLLM({
              client: anthropic,
              input: {
                questionLabel: cand.label || null,
                desiredHint:
                  "a reasonable, truthful answer; prefer a substantive option over 'decline'/'prefer not to answer' unless declining is the only choice",
                candidates: [
                  { label: cand.label || null, options: cand.options.map((o) => o.text) },
                ],
              },
              captureFn,
            }).catch(() => null)
          : null;
      const chosenText =
        llmVerdict && llmVerdict.optionIndex !== null
          ? (cand.options[llmVerdict.optionIndex]?.text ?? null)
          : chooseRequiredSelectOption(cand.options.map((o) => o.text));
      if (chosenText === null) {
        allCommitted = false;
        continue;
      }
      const chosen = cand.options.find((o) => o.text === chosenText);
      if (!chosen) {
        allCommitted = false;
        continue;
      }
      const { ok, stillInvalid } = await applySelectValue(page, cand.selIdx, chosen.value);
      if (ok && !stillInvalid) {
        logger.info(
          `required-select primitive: filled "${cand.label.slice(0, 40)}" with "${chosen.text.slice(0, 40)}"`
        );
      } else {
        allCommitted = false;
        logger.info(
          `required-select primitive: "${cand.label.slice(0, 40)}" did not commit (ok=${ok} stillInvalid=${stillInvalid})`
        );
      }
    }
    return allCommitted;
  } catch (err) {
    logger.warn(
      `required-select primitive: evaluate threw: ${toErrorMessage(err)}; falling through`
    );
    return false;
  }
}

/**
 * Site-agnostic checkbox primitive: answer a multi-select checkbox-group
 * question by directly checking the matching option in the DOM, bypassing
 * Stagehand observe/act.
 *
 * Why this exists (parallels `trySelectPrimitive`): HCA/Talemetry render
 * multi-select screening questions ("In which settings have you worked…",
 * certifications) as `c-MultiCheckboxInput` groups — a `<fieldset>`/`<legend>`
 * question with `<input type=checkbox>` options, each tied to its text by a
 * canonical `<label for="checkbox-id">Option</label>`. Stagehand observe can't
 * reliably resolve "select 'Hospital'" against these, so the required question
 * goes unanswered, "Next" no-ops on validation, and the run caps at the
 * question pages. This primitive enumerates the checkbox groups (bypassing
 * observe), matches the requested option deterministically (or via the LLM
 * picker when the flow's hint doesn't exist in this requisition's options),
 * and checks it via the React-safe click + bubbling change.
 *
 * The flow names ONE option per step ("select 'Hospital'"), so this checks a
 * single option per call. Returns true when a matching option was checked
 * (cascade skipped); false when the step isn't a select-style step, there are
 * no checkbox groups, or no option fits (fall through to the cascade — which is
 * also where `<select>`-only pages go, since trySelectPrimitive runs first).
 */
async function tryCheckboxPrimitive(params: {
  page: Page;
  instruction: string;
  logger: Logger;
  anthropic: Anthropic | null;
  captureFn?: JudgeCaptureFn;
}): Promise<boolean> {
  const { page, instruction, logger, anthropic, captureFn } = params;
  const parsed = parseSelectStep(instruction);
  if (!parsed) return false;
  const { option, questionLabel } = parsed;
  const optLabel = `option "${option.slice(0, 40)}"${questionLabel ? `, question "${questionLabel.slice(0, 40)}"` : ""}`;
  // Phase 1 (browser, no mutation): find checkbox GROUPS and their options.
  // A group is a `c-MultiCheckboxInput` container or a `<fieldset>` containing
  // checkboxes. Question label = the group's legend / associated label; each
  // option = the `<label for=checkbox-id>` text (canonical association). Try a
  // deterministic option-text match first; if unique, check it (no LLM). Else
  // return the groups so the LLM picks which group + which option.
  const enumerateExpr = `((option) => {
    const norm = (s) => (s || "").replace(/\\s+/g, " ").trim().toLowerCase();
    const wantOpt = norm(option);
    // Collect groups: c-MultiCheckboxInput roots, else fieldsets with checkboxes.
    let groupEls = Array.from(document.querySelectorAll("[class*='MultiCheckboxInput'],[class*='c-MultiCheckboxInput-root']"));
    if (groupEls.length === 0) {
      groupEls = Array.from(document.querySelectorAll("fieldset")).filter(
        (f) => f.querySelector("input[type=checkbox]")
      );
    }
    if (groupEls.length === 0) return { groupPresent: false };
    const groupLabel = (g) => {
      const leg = g.querySelector("legend");
      if (leg && leg.textContent) return leg.textContent.replace(/\\s+/g, " ").trim();
      const al = g.getAttribute("aria-label") || g.getAttribute("label");
      if (al) return al.replace(/\\s+/g, " ").trim();
      const alb = g.getAttribute("aria-labelledby");
      if (alb) { const el = document.getElementById(alb.split(/\\s+/)[0]); if (el) return (el.textContent||"").replace(/\\s+/g," ").trim(); }
      return "";
    };
    // For a checkbox, its option text = <label for=id>, else nearest label text.
    const cbLabel = (cb) => {
      if (cb.id) {
        try {
          const esc = (window.CSS && CSS.escape) ? CSS.escape(cb.id) : cb.id;
          const lf = document.querySelector('label[for="' + esc + '"]');
          if (lf && lf.textContent) return lf.textContent.replace(/\\s+/g, " ").trim();
        } catch (e) {}
      }
      const al = cb.getAttribute("aria-label");
      if (al) return al.replace(/\\s+/g, " ").trim();
      const p = cb.closest("label");
      if (p && p.textContent) return p.textContent.replace(/\\s+/g, " ").trim();
      return "";
    };
    const setChecked = (cb) => {
      if (!cb.checked) {
        cb.checked = true;
        cb.dispatchEvent(new Event("click", { bubbles: true }));
        cb.dispatchEvent(new Event("input", { bubbles: true }));
        cb.dispatchEvent(new Event("change", { bubbles: true }));
      }
      return cb.checked === true;
    };
    // Build group list with per-option labels; track DOM index for apply.
    const groups = [];
    for (let gi = 0; gi < groupEls.length; gi++) {
      const boxes = Array.from(groupEls[gi].querySelectorAll("input[type=checkbox]"));
      if (boxes.length === 0) continue;
      const options = boxes.map((cb, bi) => ({ bi, text: cbLabel(cb) })).filter((o) => o.text);
      groups.push({ gi, label: groupLabel(groupEls[gi]), options });
    }
    if (groups.length === 0) return { groupPresent: false };
    // Deterministic: exactly one option across all groups equals wantOpt.
    let detHits = [];
    for (const grp of groups) {
      for (const o of grp.options) {
        if (norm(o.text) === wantOpt) detHits.push({ gi: grp.gi, bi: o.bi, text: o.text });
      }
    }
    if (detHits.length === 1) {
      const h = detHits[0];
      const grpEl = groupEls[h.gi];
      const cb = grpEl.querySelectorAll("input[type=checkbox]")[h.bi];
      const ok = cb ? setChecked(cb) : false;
      return { groupPresent: true, applied: true, ok, chosen: h.text };
    }
    // LLM path: return groups (label + option texts) for the picker.
    return { groupPresent: true, applied: false, groups: groups.map((g) => ({ gi: g.gi, label: g.label, options: g.options })) };
  })(${JSON.stringify(option)})`;
  try {
    // Settle-retry: the checkbox group may render a beat after the step fires
    // (SPA render-lag); poll until it appears or the cap is hit.
    const enumResult = await pollEnumerate<{
      groupPresent: boolean;
      applied?: boolean;
      ok?: boolean;
      chosen?: string;
      groups?: { gi: number; label: string; options: { bi: number; text: string }[] }[];
    }>(page, enumerateExpr, (r) => r?.groupPresent === true);
    if (!enumResult?.groupPresent) return false; // no checkbox groups → cascade
    if (enumResult.applied && enumResult.ok) {
      logger.info(
        `checkbox primitive: checked "${(enumResult.chosen || "").trim().slice(0, 40)}" (${optLabel})`
      );
      return true;
    }
    const groups = enumResult.groups ?? [];
    if (anthropic === null || groups.length === 0) {
      logger.info(
        `checkbox primitive: no unique option match for ${optLabel}${anthropic === null ? " (no LLM client)" : ""}; falling through to cascade`
      );
      return false;
    }
    // LLM picks which group answers the question + which option. Reuse the
    // select-option judge (candidate "dropdowns" == checkbox groups here).
    const verdict = await judgeSelectOptionWithLLM({
      client: anthropic,
      input: {
        questionLabel,
        desiredHint: option,
        candidates: groups.map((g) => ({
          label: g.label || null,
          options: g.options.map((o) => o.text),
        })),
      },
      captureFn,
    });
    if (!verdict || verdict.selectIndex === null || verdict.optionIndex === null) {
      logger.info(
        `checkbox primitive: LLM found no matching group for ${optLabel}${verdict ? ` (${verdict.reason})` : ""}; falling through to cascade`
      );
      return false;
    }
    // biome-ignore lint/style/noNonNullAssertion: guarded above by the verdict.selectIndex === null early-return
    const chosenGroup = groups[verdict.selectIndex]!;
    // biome-ignore lint/style/noNonNullAssertion: guarded above by the verdict.optionIndex === null early-return
    const chosenOption = chosenGroup.options[verdict.optionIndex]!;
    const applyExpr = `((gi, bi) => {
      let groupEls = Array.from(document.querySelectorAll("[class*='MultiCheckboxInput'],[class*='c-MultiCheckboxInput-root']"));
      if (groupEls.length === 0) groupEls = Array.from(document.querySelectorAll("fieldset")).filter((f) => f.querySelector("input[type=checkbox]"));
      const grp = groupEls[gi];
      if (!grp) return { ok: false };
      const cb = grp.querySelectorAll("input[type=checkbox]")[bi];
      if (!cb) return { ok: false };
      if (!cb.checked) {
        cb.checked = true;
        cb.dispatchEvent(new Event("click", { bubbles: true }));
        cb.dispatchEvent(new Event("input", { bubbles: true }));
        cb.dispatchEvent(new Event("change", { bubbles: true }));
      }
      return { ok: cb.checked === true };
    })(${JSON.stringify(chosenGroup.gi)}, ${JSON.stringify(chosenOption.bi)})`;
    const applyResult = (await page.evaluate(applyExpr)) as { ok: boolean };
    if (applyResult?.ok) {
      logger.info(
        `checkbox primitive: LLM checked "${chosenOption.text.slice(0, 40)}" for ${optLabel} (${verdict.reason.slice(0, 60)})`
      );
      return true;
    }
    logger.info(
      `checkbox primitive: LLM-chosen checkbox did not stick for ${optLabel}; falling through`
    );
    return false;
  } catch (err) {
    logger.warn(`checkbox primitive: evaluate threw: ${toErrorMessage(err)}; falling through`);
    return false;
  }
}

/** One radio group enumerated from the DOM for `selectRadioGroupOption`. */
export type RadioGroupCandidate = {
  /** Index into the DOM's radio-group list (stable across the enumerate/apply pair). */
  gi: number;
  /** The group's legend/label text; empty string when the group is unlabeled. */
  label: string;
  /**
   * The group's radio options. `ri` is the raw radio DOM index within the group;
   * `id`/`xpath` are stable locator hints threaded to the trusted-click commit
   * (`applyRadioSelection`) — `id` preferred, `xpath` the no-id fallback.
   */
  options: { ri: number; text: string; id: string; xpath: string }[];
  /** True when the group already has a checked radio (answered by an earlier step). */
  alreadyChecked: boolean;
};

/**
 * Build an XPath predicate that matches an `<input>` by its `id`, safe for any
 * id value. MUI/Talemetry radio ids are base64-ish (no double-quote), so a plain
 * quoted literal suffices — but if an id ever contains a `"`, fall back to
 * `concat(...)` so the XPath stays valid. Pure + exported for unit tests.
 */
export function buildRadioIdXPath(id: string): string {
  if (!id.includes('"')) return `xpath=//input[@id="${id}"]`;
  const parts = id.split('"').map((seg) => `"${seg}"`);
  return `xpath=//input[@id=concat(${parts.join(", '\"', ")})]`;
}

/**
 * Choose which radio group + option answers a flow step, deterministically and
 * positionally. Pure (no DOM/LLM) so it is unit-testable — the crux of the
 * unlabeled-radio disambiguation.
 *
 * Why this exists: HCA/Talemetry Basic Info has multiple UNLABELED yes/no groups
 * (visa-sponsorship, common-domicile), answered by consecutive flow steps. The
 * old in-browser matcher treated an unlabeled group (`label===""`) as matching
 * ANY question (`"".includes(q)`/`q.includes("")===0`), so two unlabeled "No"
 * groups both matched → ambiguous → an LLM guess that could answer one group
 * twice and leave the other required-blank. This picks the k-th unanswered
 * unlabeled group for the k-th unlabeled step instead.
 *
 * Resolution order (already-answered groups — `alreadyChecked` — are excluded
 * throughout, since a prior step leaves its group's radio checked):
 *  1. exactly one unanswered group whose NON-empty label genuinely matches the
 *     question (substring either way) AND offers the wanted option → pick it;
 *  2. more than one such labeled match → `"ambiguous"` (caller uses the LLM);
 *  3. else (no labeled match — the question is unlabeled-in-DOM) → the FIRST
 *     unanswered group in DOM order that offers the wanted option → pick it
 *     (positional: k-th unlabeled step → k-th unlabeled group);
 *  4. nothing offers the wanted option → `null` (caller falls through).
 */
export function selectRadioGroupOption(params: {
  groups: readonly RadioGroupCandidate[];
  wantOption: string;
  questionLabel: string | null;
}): { gi: number; ri: number } | null | "ambiguous" {
  const { groups, wantOption, questionLabel } = params;
  const norm = (s: string | null | undefined): string =>
    (s ?? "").replace(/\s+/g, " ").trim().toLowerCase();
  const wantOpt = norm(wantOption);
  const normQ = norm(questionLabel);
  const optionRi = (g: RadioGroupCandidate): number | null => {
    const hit = g.options.find((o) => norm(o.text) === wantOpt);
    return hit ? hit.ri : null;
  };
  // Significant-token overlap: robust to phrasing variance between the flow's
  // question and the DOM legend ("...served in a branch of the US Military?" vs
  // "...served in the US Military?"). Stop-words are dropped so overlap reflects
  // content words. A shared-token ratio (over the shorter side) ≥ 0.5 counts as
  // a genuine label match — stricter than substring (which missed the variance)
  // but tolerant of small wording differences.
  const STOP = new Set([
    "a",
    "an",
    "the",
    "of",
    "to",
    "in",
    "on",
    "at",
    "for",
    "and",
    "or",
    "is",
    "are",
    "you",
    "your",
    "have",
    "has",
    "do",
    "does",
    "did",
    "with",
    "any",
    "this",
    "that",
    "as",
    "be",
    "been",
    "was",
    "were",
    "will",
    "would",
    "can",
    "us",
  ]);
  const tokens = (s: string): Set<string> =>
    new Set(s.split(/[^a-z0-9]+/).filter((t) => t.length > 1 && !STOP.has(t)));
  const overlapRatio = (gl: string): number => {
    const a = tokens(gl);
    const b = tokens(normQ);
    if (a.size === 0 || b.size === 0) return 0;
    let shared = 0;
    for (const t of a) if (b.has(t)) shared++;
    return shared / Math.min(a.size, b.size);
  };
  const unanswered = groups.filter((g) => !g.alreadyChecked);
  // (1)/(2) labeled match: among unanswered groups that OFFER the option and have
  // a non-empty label, score token-overlap with the question; a genuine match is
  // ratio ≥ 0.5. Empty labels never count as a label match (→ positional below).
  if (normQ) {
    const scored = unanswered
      .filter((g) => norm(g.label) && optionRi(g) !== null)
      .map((g) => ({ g, score: overlapRatio(norm(g.label)) }))
      .filter((x) => x.score >= 0.5)
      .sort((a, b) => b.score - a.score);
    if (scored.length === 1) {
      // biome-ignore lint/style/noNonNullAssertion: scored.length === 1 in this branch
      const g = scored[0]!.g;
      // biome-ignore lint/style/noNonNullAssertion: g survived the optionRi(g) !== null filter above
      return { gi: g.gi, ri: optionRi(g)! };
    }
    if (scored.length > 1) {
      // A clearly-best match (strictly higher than the runner-up) is not
      // ambiguous; only a tie defers to the LLM.
      // biome-ignore lint/style/noNonNullAssertion: scored.length > 1 so indices 0 and 1 both exist
      if (scored[0]!.score > scored[1]!.score) {
        // biome-ignore lint/style/noNonNullAssertion: scored.length > 1 in this branch
        const g = scored[0]!.g;
        // biome-ignore lint/style/noNonNullAssertion: g survived the optionRi(g) !== null filter above
        return { gi: g.gi, ri: optionRi(g)! };
      }
      return "ambiguous";
    }
    // No labeled group matched the question. If any unanswered group HAS a
    // (non-matching) label, this question's group may just be phrased
    // differently OR be one of several — don't positional-pick a labeled group
    // meant for another question. Only positional-pick among UNLABELED groups.
  }
  // (3) positional: first unanswered UNLABELED group (DOM order) offering the
  // option — the k-th unlabeled step answers the k-th unlabeled group. Applies
  // when the question is unlabeled, or when no labeled group matched and the
  // remaining candidates are unlabeled (the identical-unlabeled-groups case).
  for (const g of unanswered) {
    if (norm(g.label)) continue; // never positional-pick a labeled group
    const ri = optionRi(g);
    if (ri !== null) return { gi: g.gi, ri };
  }
  // (4) Fallback: if the question is unlabeled and there are no unlabeled groups
  // left but a labeled group offers the option, take the first such (best effort).
  if (!normQ) {
    for (const g of unanswered) {
      const ri = optionRi(g);
      if (ri !== null) return { gi: g.gi, ri };
    }
  }
  // (5) nothing offers the option / no safe pick.
  return null;
}

/**
 * Site-agnostic RADIO primitive: answer a single-choice radio-group question by
 * directly selecting the matching option in the DOM, bypassing Stagehand
 * observe/act.
 *
 * Why this exists (parallels `trySelectPrimitive`/`tryCheckboxPrimitive`):
 * HCA/Talemetry render eligibility/screening questions as MUI radio groups.
 * Stagehand observe resolves the step to a wrapper `<div>`/`<span>`, not the
 * `<input type=radio>`, so the cascade's `el.click()` fallback fires on the
 * wrapper (or sets `.checked` without triggering React's `onChange`) and the
 * controlled value never commits — the field stays `Mui-error` "required", Next
 * no-ops, and the wizard walls (measured on HCA: the "Are you at least 18?"
 * radio was the sole unfilled field blocking Basic Information → Step 2 of 10).
 * This primitive finds the radio group by raw DOM, matches the requested option
 * by its `<label for>` text, and commits via the React-safe native `checked`
 * setter + bubbling `click`/`input`/`change` (the same technique the select
 * primitive uses for `<select>.value`), so React/MUI's value tracker registers
 * the change. It then verifies the input is actually `checked` AND the group is
 * no longer invalid before claiming success; otherwise it falls through to the
 * cascade unchanged.
 *
 * When the flow's hardcoded option text isn't uniquely present (per-req
 * variance), it enumerates the groups' real options and asks the same
 * select-option LLM judge to pick group+option. A page with no radio group
 * (checkbox/select/absent) falls through to the cascade.
 */
async function tryRadioPrimitive(params: {
  page: Page;
  instruction: string;
  logger: Logger;
  anthropic: Anthropic | null;
  captureFn?: JudgeCaptureFn;
}): Promise<boolean> {
  const { page, instruction, logger, anthropic, captureFn } = params;
  const parsed = parseRadioStep(instruction);
  if (!parsed) return false;
  const { option, questionLabel } = parsed;
  const optLabel = `option "${option.slice(0, 40)}"${questionLabel ? `, question "${questionLabel.slice(0, 40)}"` : ""}`;
  // Phase 1 (browser): find radio GROUPS and their options. A group is a
  // `<fieldset>` / `[role=radiogroup]` / `[class*='RadioGroup']` container with
  // radios. Question label = the group's legend / associated label; each option
  // = the `<label for=radio-id>` text. Deterministic unique option-text match
  // commits immediately (no LLM). Else return groups for the LLM picker.
  // `commit` uses the React-safe native `checked` setter so MUI/React registers
  // the change, then reports `ok` = post-commit `radio.checked && !invalid`.
  const enumerateExpr = `((option) => {
    const norm = (s) => (s || "").replace(/\\s+/g, " ").trim().toLowerCase();
    let groupEls = Array.from(document.querySelectorAll("fieldset,[role='radiogroup'],[class*='RadioGroup']"))
      .filter((g) => g.querySelector("input[type=radio]"));
    if (groupEls.length === 0) return { groupPresent: false };
    const groupLabel = (g) => {
      const leg = g.querySelector("legend");
      if (leg && leg.textContent) return leg.textContent.replace(/\\s+/g, " ").trim();
      const al = g.getAttribute("aria-label") || g.getAttribute("label");
      if (al) return al.replace(/\\s+/g, " ").trim();
      const alb = g.getAttribute("aria-labelledby");
      if (alb) { const el = document.getElementById(alb.split(/\\s+/)[0]); if (el) return (el.textContent||"").replace(/\\s+/g," ").trim(); }
      return "";
    };
    const rbLabel = (rb) => {
      if (rb.id) {
        try {
          const esc = (window.CSS && CSS.escape) ? CSS.escape(rb.id) : rb.id;
          const lf = document.querySelector('label[for="' + esc + '"]');
          if (lf && lf.textContent) return lf.textContent.replace(/\\s+/g, " ").trim();
        } catch (e) {}
      }
      const al = rb.getAttribute("aria-label");
      if (al) return al.replace(/\\s+/g, " ").trim();
      const p = rb.closest("label");
      if (p && p.textContent) return p.textContent.replace(/\\s+/g, " ").trim();
      return "";
    };
    // Enumerate only (no selection/commit here — TS's selectRadioGroupOption
    // decides, so the disambiguation is deterministic + unit-testable). Per
    // group, report whether it already has a checked radio so answered groups
    // (from earlier steps) are excluded → positional pick of the k-th unlabeled
    // group for the k-th unlabeled step.
    const groups = [];
    for (let gi = 0; gi < groupEls.length; gi++) {
      const radios = Array.from(groupEls[gi].querySelectorAll("input[type=radio]"));
      if (radios.length === 0) continue;
      // NOTE: ri is the raw radio DOM index (assigned in .map BEFORE .filter), so
      // it stays aligned with the group's Nth <input type=radio> for the xpath
      // fallback below. Do NOT reorder map/filter or ri↔DOM index will drift.
      const options = radios
        .map((rb, ri) => ({
          ri,
          text: rbLabel(rb),
          id: rb.id || "",
          xpath:
            "(//fieldset|//*[@role='radiogroup']|//*[contains(@class,'RadioGroup')])[" +
            (gi + 1) +
            "]//input[@type='radio'][" +
            (ri + 1) +
            "]",
        }))
        .filter((o) => o.text);
      const alreadyChecked = radios.some((rb) => rb.checked === true);
      groups.push({ gi, label: groupLabel(groupEls[gi]), options, alreadyChecked });
    }
    if (groups.length === 0) return { groupPresent: false };
    return { groupPresent: true, groups };
  })(${JSON.stringify(option)})`;
  try {
    const enumResult = await pollEnumerate<{
      groupPresent: boolean;
      groups?: RadioGroupCandidate[];
    }>(page, enumerateExpr, (r) => r?.groupPresent === true);
    if (!enumResult?.groupPresent) return false; // no radio group → cascade
    const groups = enumResult.groups ?? [];
    if (groups.length === 0) return false;
    // Deterministic + positional selection (excludes already-answered groups,
    // fixes the empty-label universal-match bug). Only genuine labeled ambiguity
    // defers to the LLM.
    const selection = selectRadioGroupOption({ groups, wantOption: option, questionLabel });
    if (selection !== null && selection !== "ambiguous") {
      const chosenOpt = groups[selection.gi]?.options.find((o) => o.ri === selection.ri);
      const applied = await applyRadioSelection(page, selection.gi, selection.ri, {
        id: chosenOpt?.id ?? "",
        xpath: chosenOpt?.xpath ?? "",
      });
      if (applied) {
        logger.info(
          `radio primitive: selected "${(chosenOpt?.text ?? "").trim().slice(0, 40)}" (${optLabel})`
        );
        return true;
      }
      logger.info(`radio primitive: chosen radio did not stick for ${optLabel}; falling through`);
      return false;
    }
    if (selection === null) {
      logger.info(
        `radio primitive: no group offers option for ${optLabel}; falling through to cascade`
      );
      return false;
    }
    // selection === "ambiguous": multiple labeled groups match → let the LLM pick.
    if (anthropic === null) {
      logger.info(
        `radio primitive: ambiguous labeled match for ${optLabel} (no LLM client); falling through to cascade`
      );
      return false;
    }
    // LLM picks which group answers the question + which option. Reuse the
    // select-option judge (candidate "dropdowns" == radio groups here). Only
    // unanswered groups are offered so the LLM can't re-answer a done group.
    const llmGroups = groups.filter((g) => !g.alreadyChecked);
    const verdict = await judgeSelectOptionWithLLM({
      client: anthropic,
      input: {
        questionLabel,
        desiredHint: option,
        candidates: llmGroups.map((g) => ({
          label: g.label || null,
          options: g.options.map((o) => o.text),
        })),
      },
      captureFn,
    });
    if (!verdict || verdict.selectIndex === null || verdict.optionIndex === null) {
      logger.info(
        `radio primitive: LLM found no matching group for ${optLabel}${verdict ? ` (${verdict.reason})` : ""}; falling through to cascade`
      );
      return false;
    }
    // biome-ignore lint/style/noNonNullAssertion: guarded above by the verdict.selectIndex === null early-return
    const chosenGroup = llmGroups[verdict.selectIndex]!;
    // biome-ignore lint/style/noNonNullAssertion: guarded above by the verdict.optionIndex === null early-return
    const chosenOption = chosenGroup.options[verdict.optionIndex]!;
    const applyResult = {
      ok: await applyRadioSelection(page, chosenGroup.gi, chosenOption.ri, {
        id: chosenOption.id,
        xpath: chosenOption.xpath,
      }),
    };
    if (applyResult?.ok) {
      logger.info(
        `radio primitive: LLM selected "${chosenOption.text.slice(0, 40)}" for ${optLabel} (${verdict.reason.slice(0, 60)})`
      );
      return true;
    }
    logger.info(`radio primitive: LLM-chosen radio did not stick for ${optLabel}; falling through`);
    return false;
  } catch (err) {
    logger.warn(`radio primitive: evaluate threw: ${toErrorMessage(err)}; falling through`);
    return false;
  }
}

/**
 * Commit a chosen radio and verify it STICKS. Tiered because synthetic events
 * set the DOM `checked` but don't flow through React/MUI's controlled-input
 * `onChange`, so the form model never records the value and MUI re-flags the
 * group `required` a beat later (the fs4 "18 years" bug: `checked=1` + `Mui-error`
 * at once). Each tier commits, waits `RADIO_SETTLE_MS` for MUI's async
 * re-validation, then re-reads BOTH signals (input checked AND no invalid
 * ancestor). Ordered most-faithful-first:
 *   A. trusted hit-tested CDP click on the input by id (the real user gesture
 *      React honors) — MUI's opacity:0 `PrivateSwitchBase-input` overlays the
 *      control so real clicks land on it;
 *   B. trusted click on the associated `<label for=id>` (when the hidden input
 *      isn't hit-testable — common on MUI);
 *   C. the legacy isolated-world synthetic-events path (backstop for no-id /
 *      detached / non-MUI radios that already commit that way).
 * Returns whether the commit stuck; false → caller falls through to the cascade.
 */
async function applyRadioSelection(
  page: Page,
  gi: number,
  ri: number,
  hint: { id: string; xpath: string }
): Promise<boolean> {
  // Post-settle readback for the input identified by id (preferred) or xpath:
  // checked===true AND no INVALID_MARKER_EL_EXPR ancestor within 6 hops.
  const readbackExpr = (sel: { id: string; xpath: string }): string => `((id, xp) => {
      const isInvalid = ${INVALID_MARKER_EL_EXPR};
      let rb = id ? document.getElementById(id) : null;
      if (!rb && xp) { const r = document.evaluate(xp, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null); rb = r.singleNodeValue; }
      if (!rb || rb.checked !== true) return { ok: false };
      let node = rb;
      for (let depth = 0; depth < 6 && node; depth++) {
        if (node.getAttribute && isInvalid(node)) return { ok: false };
        node = node.parentElement;
      }
      return { ok: true };
    })(${JSON.stringify(sel.id)}, ${JSON.stringify(sel.xpath)})`;
  const readback = async (): Promise<boolean> => {
    await page.waitForTimeout(RADIO_SETTLE_MS);
    const r = (await page.evaluate(readbackExpr(hint)).catch(() => ({ ok: false }))) as {
      ok: boolean;
    };
    return r?.ok === true;
  };

  // Tier A — trusted hit-tested click on the input by id (or xpath).
  const inputSel = hint.id ? buildRadioIdXPath(hint.id) : hint.xpath ? `xpath=${hint.xpath}` : null;
  if (inputSel) {
    try {
      await page.locator(inputSel).first().click();
      if (await readback()) return true;
    } catch {
      // fall through to the next tier
    }
  }

  // Tier B — trusted click on the associated label (MUI hides the real input).
  if (hint.id) {
    try {
      await page
        .locator(`xpath=//label[@for=${JSON.stringify(hint.id)}]`)
        .first()
        .click();
      if (await readback()) return true;
    } catch {
      // fall through to the synthetic backstop
    }
  }

  // Tier C — legacy synthetic-events backstop (native setter + bubbling events).
  const applyExpr = `((gi, ri) => {
      const isInvalid = ${INVALID_MARKER_EL_EXPR};
      const groupEls = Array.from(document.querySelectorAll("fieldset,[role='radiogroup'],[class*='RadioGroup']"))
        .filter((g) => g.querySelector("input[type=radio]"));
      const grp = groupEls[gi];
      if (!grp) return { ok: false };
      const rb = grp.querySelectorAll("input[type=radio]")[ri];
      if (!rb) return { ok: false };
      const desc = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "checked");
      if (desc && desc.set) { desc.set.call(rb, true); } else { rb.checked = true; }
      rb.dispatchEvent(new Event("click", { bubbles: true }));
      rb.dispatchEvent(new Event("input", { bubbles: true }));
      rb.dispatchEvent(new Event("change", { bubbles: true }));
      if (rb.checked !== true) return { ok: false };
      let node = rb;
      for (let depth = 0; depth < 6 && node; depth++) {
        if (node.getAttribute && isInvalid(node)) return { ok: false };
        node = node.parentElement;
      }
      return { ok: true };
    })(${JSON.stringify(gi)}, ${JSON.stringify(ri)})`;
  await page.evaluate(applyExpr).catch(() => ({ ok: false }));
  return await readback();
}

/**
 * Guard for the optional-step fast-skip: is there a REQUIRED, still-empty (or
 * aria-invalid) form control on the page whose nearby label matches this step's
 * question? A `parseSelectStep`-style optional step that "found no candidates"
 * would normally skip cleanly — but when the page plainly has a required control
 * the step was meant to answer (SPA hydration lag, or a driver gap where observe
 * can't resolve the widget), skipping leaves a required field empty and silently
 * dooms the later submit. Returns true → the caller should NOT fast-skip and
 * should fall through to the cascade/replan instead.
 *
 * Conservative by construction: returns false unless the step parses as a
 * select/answer step AND a required-and-unsatisfied control with a
 * label-matching the question is actually present. A genuinely-absent optional
 * step (e.g. "dismiss modal" on a modal-less page) has no such control, so the
 * fast-skip the comments call essential is preserved.
 */
async function hasUnfilledRequiredControlForStep(
  page: Page,
  instruction: string
): Promise<boolean> {
  const parsed = parseSelectStep(instruction);
  if (!parsed?.questionLabel) return false;
  const expr = `((label) => {
    const norm = (s) => (s || "").replace(/\\s+/g, " ").trim().toLowerCase();
    const want = norm(label);
    if (!want) return false;
    const isInvalid = ${INVALID_MARKER_EL_EXPR};
    // Required markers: the control itself, or a required-asterisk label nearby.
    const isRequired = (el) => {
      if (!el || !el.getAttribute) return false;
      if (el.hasAttribute("required")) return true;
      if (el.getAttribute("aria-required") === "true") return true;
      return false;
    };
    const isEmptyish = (el) => {
      if (!el) return false;
      if (el.getAttribute && el.getAttribute("aria-invalid") === "true") return true;
      if (isInvalid(el)) return true;
      const v = ("value" in el) ? el.value : "";
      return !v || String(v).trim() === "";
    };
    // Scan form controls; for each required+empty one, check whether a nearby
    // label (ancestor label/legend, or [aria-labelledby], or preceding label)
    // contains the question text.
    const controls = Array.from(document.querySelectorAll(
      "input,select,textarea,[role=combobox],[role=listbox],.bb-custom-select-container,[class*='MultiCheckboxInput']"
    ));
    for (const el of controls) {
      if (!isRequired(el) && !(el.querySelector && el.querySelector("[required],[aria-required=true]"))) {
        // container widgets carry required on an inner element; allow those
        if (!/bb-custom-select-container|MultiCheckboxInput/.test((el.getAttribute && el.getAttribute("class")) || "")) continue;
      }
      // is it empty/invalid?
      const emptyOrInvalid = isEmptyish(el) || (el.querySelector && !!el.querySelector("[aria-invalid=true]"));
      if (!emptyOrInvalid) continue;
      // does a nearby label match the question?
      let node = el;
      for (let d = 0; d < 6 && node; d++) {
        const lbl = node.querySelector && node.querySelector("label,legend");
        const txt = lbl && lbl.textContent ? norm(lbl.textContent) : "";
        if (txt && (txt.includes(want) || want.includes(txt))) return true;
        node = node.parentElement;
      }
    }
    return false;
  })(${JSON.stringify(parsed.questionLabel)})`;
  try {
    return (await page.evaluate(expr)) === true;
  } catch {
    return false;
  }
}

/**
 * Synthesize a drag-drop event sequence on the most-likely upload drop
 * zone using DataTransfer + DragEvent. Used as K'4 fallback when
 * setInputFiles + change-event dispatch don't trigger the framework's
 * file-registration handler (some custom upload widgets only listen
 * for `drop` events on a wrapper element, not for `change` on the
 * underlying input).
 *
 * Drop zone detection is keyword-based: searches for elements with
 * upload/dropzone/file-related class or tag names. Tries multiple
 * candidates in order. Returns true on first success.
 *
 * Site-agnostic — DataTransfer + DragEvent dispatch is universal HTML5
 * drag-and-drop API. Works on react-dropzone, Material Dropzone, custom
 * <uapp-upload>/<app-upload>, and any other drop-zone-based upload UI.
 */
async function simulateDragDropUpload(
  page: Page,
  fixture: { buffer: Buffer; name: string; mimeType: string },
  logger: Logger
): Promise<boolean> {
  const base64 = fixture.buffer.toString("base64");
  const expr = `(async () => {
    const fileName = ${JSON.stringify(fixture.name)};
    const fileType = ${JSON.stringify(fixture.mimeType)};
    const base64 = ${JSON.stringify(base64)};
    const dropZoneSelectors = [
      "uapp-upload",
      "app-upload",
      "uapp-resume-upload",
      "[class*='dropzone']",
      "[class*='drop-zone']",
      "[class*='file-drop']",
      "[class*='upload-zone']",
      "[class*='uapp-upload']",
      "[class*='ResumeUpload']",
      "[class*='resumeUpload']",
      "[class*='resume-upload']",
    ];
    let dropZone = null;
    for (const sel of dropZoneSelectors) {
      const el = document.querySelector(sel);
      if (el) { dropZone = el; break; }
    }
    if (!dropZone) return { ok: false, reason: "no drop zone found" };
    try {
      const binStr = atob(base64);
      const bytes = new Uint8Array(binStr.length);
      for (let i = 0; i < binStr.length; i++) bytes[i] = binStr.charCodeAt(i);
      const file = new File([bytes], fileName, { type: fileType });
      const dt = new DataTransfer();
      dt.items.add(file);
      for (const evtName of ["dragenter", "dragover", "drop"]) {
        const evt = new DragEvent(evtName, {
          bubbles: true,
          cancelable: true,
          dataTransfer: dt,
        });
        dropZone.dispatchEvent(evt);
      }
      return { ok: true, dropZoneTag: dropZone.tagName.toLowerCase() };
    } catch (e) {
      return { ok: false, reason: e instanceof Error ? e.message : String(e) };
    }
  })()`;
  try {
    const result = await page.evaluate(expr);
    if (result && typeof result === "object" && "ok" in result && result.ok === true) {
      const tag = "dropZoneTag" in result ? String(result.dropZoneTag) : "(unknown)";
      logger.info(`upload primitive: drag-drop dispatched on <${tag}>`);
      return true;
    }
    const reason =
      result && typeof result === "object" && "reason" in result
        ? String(result.reason)
        : "(unknown)";
    logger.warn(`upload primitive: drag-drop fallback skipped: ${reason}`);
    return false;
  } catch (err) {
    logger.warn(`upload primitive: drag-drop fallback threw: ${toErrorMessage(err)}`);
    return false;
  }
}

/**
 * Dispatch DOM `input` + `change` + `blur` events on the given element from the
 * page context. Stagehand's `fill` for regular text inputs types via CDP
 * `Input.insertText` which fires `input` per keystroke but never fires `change`
 * — `change` only fires on blur, and Stagehand never blurs. Many jQuery /
 * Backbone forms (e.g. a delegated `formField.js`-style handler) bind their
 * input handlers to the native `change` event via event delegation; without
 * `change` firing,
 * the form's internal data model never records the typed value, so when the
 * SPA re-renders the form the value is wiped back to empty.
 *
 * This helper closes that gap. Idempotent: dispatching change after a
 * successful fill is a no-op for forms that don't bind to `change`, and a
 * mandatory wake-up for forms that do.
 *
 * Trust boundary: xpath comes from Stagehand's resolved selector. JSON.stringify
 * safely escapes it into a JS string literal. The expression body is a fixed
 * literal — no user-controlled JS execution.
 */
async function dispatchJqueryChangeEvent(page: Page, selector: string): Promise<void> {
  const xpath = xpathBody(selector);
  if (!xpath) return;
  const expr = `(() => {
    const r = document.evaluate(${JSON.stringify(xpath)}, document, null,
      XPathResult.FIRST_ORDERED_NODE_TYPE, null);
    const el = r.singleNodeValue;
    if (!el) return "no-element";
    try {
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.dispatchEvent(new Event('blur', { bubbles: true }));
      return "dispatched";
    } catch (e) {
      return "threw:" + (e && e.message || String(e));
    }
  })()`;
  try {
    await page.evaluate(expr);
  } catch {
    // best-effort: jQuery dispatch failure shouldn't fail the verifier
  }
}

/**
 * For state-class Stagehand actions (`fill`, `check`, etc.) the network/URL
 * heuristic is meaningless — typing into an input never fires a request.
 * Re-read DOM state from the same selector Stagehand acted upon and compare
 * against what it tried to write. Falls back to `false` on any locator error
 * so the navigation-class signal is still the deciding vote when this returns.
 */
async function verifyDomEffect(page: Page, action: Action): Promise<boolean> {
  const selector = action.selector;
  const method = action.method;
  if (!selector || !method) return false;
  try {
    const locator = page.locator(selector).first();
    switch (method) {
      case "fill":
      case "type": {
        const expected = action.arguments?.[0];
        if (typeof expected !== "string" || expected.length === 0) return false;
        const current = await locator.inputValue();
        const hit = current.includes(expected);
        if (hit) {
          // Stagehand typed via CDP Input.insertText which fires `input` per
          // keystroke but never fires `change`. Dispatch change here so jQuery/
          // Backbone forms (e.g. a `"change .field-dropdown,.form-input"`
          // delegated handler) record the value
          // into their internal data model. Without this, the SPA's next
          // re-render wipes the typed value back to empty.
          await dispatchJqueryChangeEvent(page, selector);

          // Angular reactive forms (e.g. ADP WOTC questionnaire on tcs.adp.com)
          // don't pick up CDP Input.insertText OR dispatchEvent('input') —
          // their FormControl model updates require real keyboard events.
          // Angular's zone.js patches keydown/keyup at the document root, so
          // synthesizing real keystrokes via CDP Input.dispatchKeyEvent (which
          // is what Stagehand's Locator.type does WITH delay) flows the values
          // through change detection → FormControl.setValue() → form validity
          // → button [disabled] re-evaluates. Verified from ADP main.js bundle:
          // button's [disabled] binds to `formStatus && !enableSubmitBtn`;
          // formStatus tracks Angular form invalidity.
          try {
            // Clear via empty fill (focuses + select-all under the hood) then
            // re-type with delay so each character is a CDP keyDown+keyUp.
            await locator.fill("");
            await locator.type(expected, { delay: 50 });
          } catch {
            // best-effort: Angular re-type failure shouldn't fail the verifier
          }
        }
        return hit;
      }
      case "check":
        return await locator.isChecked();
      case "uncheck":
        return !(await locator.isChecked());
      case "selectOption":
      case "selectOptionFromDropdown": {
        // Stagehand dispatches both names to Playwright's `locator.selectOption(text)`,
        // which only succeeds on native <select> and matches the input against any of
        // the option's value/label/textContent. Mirror that resolution at verify time
        // so we get a real equality signal — Playwright's "selection happened" succeeds
        // iff one of those three fields matches.
        const expected = action.arguments?.[0]?.toString().trim() ?? "";
        if (!expected) return false;
        const xpath = xpathBody(selector);
        if (!xpath) {
          const current = await locator.inputValue().catch(() => "");
          return current.length > 0;
        }
        // Same trust-boundary rationale as the click case below: xpath is from
        // Stagehand's resolved selector, JSON.stringify produces a safe JS string
        // literal, and the expression cannot inject behavior through xpath content.
        const expr = `(() => { const r = document.evaluate(${JSON.stringify(xpath)}, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null); const el = r.singleNodeValue; if (!el || el.tagName !== "SELECT") return null; const opt = el.options[el.selectedIndex]; if (!opt) return { value: "", label: "", text: "" }; return { value: (opt.value || "").trim(), label: (opt.label || "").trim(), text: (opt.textContent || "").trim() }; })()`;
        let selected: { value: string; label: string; text: string } | null = null;
        try {
          const result = await page.evaluate(expr);
          if (
            result !== null &&
            typeof result === "object" &&
            "value" in result &&
            "label" in result &&
            "text" in result
          ) {
            selected = result as { value: string; label: string; text: string };
          }
        } catch {
          return false;
        }
        if (!selected) return false;
        const want = expected.toLowerCase();
        return (
          (selected.value.length > 0 && selected.value.toLowerCase().includes(want)) ||
          (selected.label.length > 0 && selected.label.toLowerCase().includes(want)) ||
          (selected.text.length > 0 && selected.text.toLowerCase().includes(want))
        );
      }
      case "setInputFiles":
        // No cheap DOM equivalent without re-resolving the file. Trust Stagehand's
        // actResultSuccess upstream — caller composes signals.
        return true;
      case "click": {
        // Clicks on radios and checkboxes toggle `:checked` without firing a
        // network request — same false-fail class as fill. For every other
        // click (buttons, links, custom toggles) return false so the verifier
        // falls back to the network/URL signal, which is the right signal there.
        const xpath = xpathBody(selector);
        if (!xpath) return false;
        let inputType: string | null = null;
        try {
          // Trust boundary: xpath comes from Stagehand's own resolved selector
          // (not URL/user input). JSON.stringify produces a safe JS string
          // literal even for content with quotes/backslashes, so composing
          // this expression cannot exfiltrate or inject behavior through the
          // xpath content alone. String expression rather than a function so
          // Node-side typechecking doesn't choke on the browser globals
          // `document`/`XPathResult`.
          const expr = `(() => { const r = document.evaluate(${JSON.stringify(xpath)}, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null); const el = r.singleNodeValue; return el ? (el.type || null) : null; })()`;
          const result = await page.evaluate(expr);
          inputType = typeof result === "string" ? result : null;
        } catch {
          return false;
        }
        if (inputType !== "radio" && inputType !== "checkbox") {
          // Real button/link click — let network/URL signal decide.
          return false;
        }
        const isCheckedNow = await locator.isChecked();
        if (!isCheckedNow) return false;
        // Vacuous-click guard. On multi-page Angular paginators an input
        // can exist in the DOM while its containing component is on a
        // hidden paginator page; CDP click + locator.isChecked both
        // return true because the DOM property updated, but Angular's
        // FormControl on the hidden component never re-validates. The
        // FormControl's container keeps its ng-invalid marker. If any
        // ancestor within 6 levels still carries a framework-agnostic
        // invalid marker after the click, treat the click as vacuous so
        // the cascade routes to rephrase/replan instead of advancing
        // past a step that didn't actually change the form state.
        const ancestorInvalidExpr = `(() => {
          const isInvalid = ${INVALID_MARKER_EL_EXPR};
          const r = document.evaluate(${JSON.stringify(xpath)}, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
          let node = r.singleNodeValue;
          if (!node) return false;
          for (let depth = 0; depth < 6 && node; depth++) {
            if (node.getAttribute && isInvalid(node)) return true;
            node = node.parentElement;
          }
          return false;
        })()`;
        const ancestorStillInvalid = await page.evaluate(ancestorInvalidExpr).catch(() => false);
        return !ancestorStillInvalid;
      }
      default:
        return false;
    }
  } catch {
    return false;
  }
}

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
export interface InvalidFormControl {
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
 * Trust boundary: static string literal, no interpolation. Runs in browser
 * context. Returns a JSON-serializable shape that the caller type-narrows.
 *
 * Two phases:
 *   1. SCAN — query each element whose class attribute matches the closed-set
 *      of framework-agnostic invalid markers (ng-invalid, mat-form-field-invalid,
 *      is-invalid, field-invalid). For each one, walk DOWN to find an
 *      `<input>` / `<select>` / `<textarea>` descendant (forms wrap controls
 *      in Angular-style `<app-input>` / `<mat-form-field>` containers), then
 *      test whether that descendant is empty or unchecked.
 *   2. AUTO-PICK — for each empty/unchecked control, take the cheapest action
 *      that clears the ng-invalid state:
 *        - radio: click the FIRST radio in the group (any choice is better
 *          than blocking submit). Dispatches `input`+`change` so Angular's
 *          FormControl picks up the change.
 *        - checkbox: click the first available checkbox.
 *        - text/textarea: set value to "NA" + dispatch `input`+`change`+`blur`.
 *        - select: pick the first non-empty option.
 *      Each auto-pick is recorded so the cascade can surface a self-heal
 *      warning ("you auto-picked X; consider adding an explicit step").
 *
 * Label resolution checks (in order) the nearest `<label>`, `aria-label`,
 * `data-id`, and `name`.
 */
const FORM_VALIDITY_PROBE_EXPR = `(() => {
  const INVALID_CLASS_RX = /(${INVALID_MARKER_CLASS_SOURCE})/;
  const MARKERS = ["ng-invalid", "mat-form-field-invalid", "is-invalid", "field-invalid", "input-invalid", "Mui-error", "ng-touched", "ng-dirty"];
  function fire(el, ev) {
    try { el.dispatchEvent(new Event(ev, { bubbles: true })); } catch (e) {}
  }
  // Iterate innermost-first: querySelectorAll is document order (outer →
  // inner), but our dedupe (below) wants to record the most-specific
  // invalid descendant and skip its outer ancestors. Reversing the order
  // means the inner <li> lands in \`out\` first, then when the outer
  // <form> shows up the contains check fires and skips it correctly.
  // Without this reversal the iteration would record both: when the outer
  // is hit first \`out\` is empty so it lands; the inner then lands too
  // because the inner does NOT contain the outer. Confirmed via the
  // 20:23-21:42 telemetry where the invalidFieldList included 4-6
  // redundant nested entries that should have been deduped.
  const allEls = Array.from(document.querySelectorAll("[class]")).reverse();
  const out = [];
  for (const el of allEls) {
    const cls = el.getAttribute("class") || "";
    if (!INVALID_CLASS_RX.test(cls)) continue;
    // De-dupe: skip the current el when it CONTAINS any already-recorded
    // element — i.e. \`el\` is an outer ancestor and we already have its
    // more-specific descendant in \`out\`. Combined with the inner-first
    // iteration above, this records only the innermost invalid form
    // control per nested hierarchy.
    if (out.some((e) => e._el && el.contains(e._el))) continue;
    const ctrl = el.matches("input,select,textarea") ? el : el.querySelector("input,select,textarea");
    if (!ctrl) continue;
    // Accept two distinct invalid signatures:
    //
    // 1. Leaf-invalid: the control's own class carries ng-invalid
    //    (Angular reactive forms decorating the <input> directly).
    //
    // 2. Wrapper-only invalid: an outer wrapper (<mat-form-field>,
    //    custom <app-*> widgets) carries the marker while the inner
    //    control stays ng-pristine ng-untouched — the structural
    //    pattern for required-but-unfilled fields under Material /
    //    Angular custom widgets.
    //
    // The wrapper-only branch MUST also require the inner control to
    // be empty. Without that constraint, an outer container's
    // ng-invalid (propagated from a sibling field) would mark its
    // first descendant input as invalid even when that input is
    // already filled — re-introducing the false positive the leaf-
    // only check was originally added to eliminate.
    const ctrlClass = ctrl.getAttribute("class") || "";
    const leafInvalid = INVALID_CLASS_RX.test(ctrlClass);
    // A <select> whose currently-selected option is .disabled is the
    // Angular "Please select..." placeholder state. Some custom-element
    // dropdowns (e.g. AppCast's app-dropdown) bind a truthy sentinel value
    // like "0: null" to the disabled placeholder, so ctrl.value !== ""
    // even though no real option is chosen. Without this branch the empty
    // check below silently drops every such wrapper and the pre-submit
    // probe reports "no ng-invalid form controls detected" on a form
    // that's actually waiting on unfilled dropdowns.
    const selectPlaceholderOpen =
      ctrl.tagName.toLowerCase() === "select" &&
      ctrl.selectedOptions[0] &&
      ctrl.selectedOptions[0].disabled;
    // MUI/React signature: the wrapper (FormControl/FormLabel) carries
    // Mui-error while the native control is empty and/or aria-invalid="true".
    // MUI has no ng-pristine/ng-untouched, so the Angular wrapper branch below
    // would skip these — accept the MUI marker (wrapper class or the control's
    // aria-invalid) as an equivalent required-unfilled signal.
    const muiInvalid =
      (/Mui-error/.test(cls) || ctrl.getAttribute("aria-invalid") === "true") &&
      (ctrl.value === "" || ctrl.value == null || selectPlaceholderOpen);
    const wrapperOnlyInvalid =
      !leafInvalid &&
      el !== ctrl &&
      (ctrl.value === "" || ctrl.value == null || selectPlaceholderOpen) &&
      (/(ng-pristine|ng-untouched)/.test(ctrlClass) || muiInvalid);
    if (!leafInvalid && !wrapperOnlyInvalid) continue;
    let label = "";
    let scan = el;
    for (let i = 0; i < 4 && scan && !label; i++) {
      const lbl = scan.querySelector("label");
      if (lbl && lbl.textContent) label = lbl.textContent.trim();
      scan = scan.parentElement;
    }
    if (!label) label = el.getAttribute("aria-label") || el.getAttribute("data-id") || ctrl.getAttribute("name") || ctrl.getAttribute("id") || "(unlabeled)";
    label = label.replace(/\\s+/g, " ").slice(0, 80);
    const classSignature = cls.split(/\\s+/).filter((c) => MARKERS.includes(c)).slice(0, 4).join(" ");
    let emptyOrUnchecked = false;
    let autoFilled = null;
    const tag = ctrl.tagName.toLowerCase();
    if (tag === "input") {
      const type = (ctrl.getAttribute("type") || "text").toLowerCase();
      if (type === "radio") {
        emptyOrUnchecked = !ctrl.checked;
        if (emptyOrUnchecked) {
          // Click the first radio in this group (radio groups share a name
          // OR live under a common ng-invalid container). Prefer the
          // container's first radio descendant so labeled groups stay
          // intact.
          const firstRadio = el.querySelector('input[type="radio"]') || ctrl;
          try {
            firstRadio.click();
            fire(firstRadio, "input");
            fire(firstRadio, "change");
            const rlbl = (firstRadio.getAttribute("aria-label") || firstRadio.value || "first option").toString();
            autoFilled = { action: "selected-radio", value: rlbl.slice(0, 60) };
          } catch (e) {}
        }
      } else if (type === "checkbox") {
        emptyOrUnchecked = !ctrl.checked;
        if (emptyOrUnchecked) {
          try {
            ctrl.click();
            fire(ctrl, "input");
            fire(ctrl, "change");
            autoFilled = { action: "checked-checkbox", value: "true" };
          } catch (e) {}
        }
      } else {
        emptyOrUnchecked = !ctrl.value;
        if (emptyOrUnchecked) {
          try {
            ctrl.value = "NA";
            fire(ctrl, "input");
            fire(ctrl, "change");
            fire(ctrl, "blur");
            autoFilled = { action: "filled-text", value: "NA" };
          } catch (e) {}
        }
      }
    } else if (tag === "select") {
      // Treat a select stuck on a .disabled placeholder option as empty
      // even when ctrl.value is a truthy string (see the app-dropdown
      // note above on the wrapperOnlyInvalid branch).
      emptyOrUnchecked =
        !ctrl.value || (ctrl.selectedOptions[0] && ctrl.selectedOptions[0].disabled);
      if (emptyOrUnchecked) {
        try {
          const firstOption = Array.from(ctrl.options || []).find((o) => o.value && !o.disabled);
          if (firstOption) {
            ctrl.value = firstOption.value;
            fire(ctrl, "input");
            fire(ctrl, "change");
            autoFilled = { action: "selected-option", value: (firstOption.textContent || firstOption.value).slice(0, 60) };
          }
        } catch (e) {}
      }
    } else if (tag === "textarea") {
      emptyOrUnchecked = !ctrl.value;
      if (emptyOrUnchecked) {
        try {
          ctrl.value = "NA";
          fire(ctrl, "input");
          fire(ctrl, "change");
          fire(ctrl, "blur");
          autoFilled = { action: "filled-text", value: "NA" };
        } catch (e) {}
      }
    }
    out.push({ label, classSignature, emptyOrUnchecked, autoFilled, _el: el });
  }
  // Strip the DOM reference before serialization.
  return out.slice(0, 12).map((e) => ({ label: e.label, classSignature: e.classSignature, emptyOrUnchecked: e.emptyOrUnchecked, autoFilled: e.autoFilled }));
})()`;

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
export function narrowInvalidFormControl(entry: unknown): InvalidFormControl | null {
  if (
    entry === null ||
    typeof entry !== "object" ||
    !("label" in entry) ||
    !("classSignature" in entry) ||
    !("emptyOrUnchecked" in entry) ||
    typeof (entry as { label: unknown }).label !== "string" ||
    typeof (entry as { classSignature: unknown }).classSignature !== "string" ||
    typeof (entry as { emptyOrUnchecked: unknown }).emptyOrUnchecked !== "boolean"
  ) {
    return null;
  }
  const af = (entry as { autoFilled?: unknown }).autoFilled;
  const narrowedAutoFilled =
    af !== null &&
    typeof af === "object" &&
    af !== undefined &&
    "action" in af &&
    "value" in af &&
    typeof (af as { action: unknown }).action === "string" &&
    typeof (af as { value: unknown }).value === "string"
      ? (af as InvalidFormControl["autoFilled"])
      : null;
  return {
    ...(entry as Omit<InvalidFormControl, "autoFilled">),
    autoFilled: narrowedAutoFilled,
  };
}

/**
 * Single source of truth for step-line prefixes. Exists because the cascade
 * here has only ever received `stepIndex`, while the orchestrator loop in
 * recon-browser owns the plan array — so half the step lines in a run printed
 * a `N/total` denominator and half printed a bare `N`.
 *
 * Takes a getter rather than a number: a global replan splices new steps into
 * the live plan array mid-run, so the total must be read when the line is
 * emitted, not when the step started. Callers with no total omit it and get
 * the bare form.
 */
export function formatStepPrefix(stepIndex: number, totalSteps?: () => number): string {
  const total = totalSteps?.();
  return total === undefined ? `step ${stepIndex + 1}` : `step ${stepIndex + 1}/${total}`;
}

async function probeFormValidityBeforeSubmit(params: {
  page: Page;
  stepIndex: number;
  totalSteps?: () => number;
  logger: Logger;
}): Promise<InvalidFormControl[]> {
  const { page, stepIndex, totalSteps, logger } = params;
  try {
    const raw = await page.evaluate(FORM_VALIDITY_PROBE_EXPR);
    if (!Array.isArray(raw)) return [];
    const out: InvalidFormControl[] = [];
    for (const entry of raw) {
      const narrowed = narrowInvalidFormControl(entry);
      if (narrowed !== null) {
        out.push(narrowed);
      }
    }
    const autoCount = out.filter((e) => e.autoFilled !== null).length;
    if (out.length > 0) {
      logger.info(
        `${formatStepPrefix(stepIndex, totalSteps)} pre-submit probe: ${out.length} ng-invalid form control(s) detected; empty=${out.filter((e) => e.emptyOrUnchecked).length}; auto-picked=${autoCount}`
      );
    } else {
      logger.info(
        `${formatStepPrefix(stepIndex, totalSteps)} pre-submit probe: no ng-invalid form controls detected`
      );
    }
    return out;
  } catch (err) {
    logger.warn(
      `${formatStepPrefix(stepIndex, totalSteps)} pre-submit probe threw: ${toErrorMessage(err)} — proceeding without pre-flight evidence`
    );
    return [];
  }
}

/**
 * Cheap pre-cascade reachability gate. Runs before the 5-attempt healing cascade
 * (and any global replan) so a step aimed at the wrong page state fails fast
 * instead of burning attempts and replan budget. A focused observe can
 * under-return on controlled-component (React/MUI) forms — returning zero
 * candidates for a declarative "Fill in X" step even when the field is present —
 * so a 0-candidate focused result falls back to an unfocused observe before the
 * step is declared "absent". Exported for tests.
 */
export async function probeStepBeforeAttempts(params: {
  stagehand: Stagehand;
  step: string;
  stepIndex: number;
  totalSteps?: () => number;
  logger: Logger;
  captureFn?: CaptureFn;
}): Promise<"present" | "absent"> {
  const { stagehand, step, stepIndex, totalSteps, logger, captureFn } = params;
  try {
    const candidates = await guardedObserve(
      stagehand,
      step,
      { timeout: STEP_WATCHDOG_MS },
      captureFn
    );
    if (candidates.length === 0) {
      // Focused observe under-returns on some controlled-component forms:
      // Stagehand's instruction-scoped observe can resolve zero candidates for a
      // declarative "Fill in the X field with 'Y'" step even when the field is
      // present and actionable (confirmed on HCA's MUI/React Talemetry form — an
      // unfocused observe enumerated every field and a direct act filled them).
      // Treating focused-empty as hard "absent" skips the whole cascade and burns
      // a global replan per step. Fall back to an UNFOCUSED observe as a
      // reachability check: if the page clearly has actionable content, hand off
      // to the cascade (its observe-act / rephrase attempts recover the field
      // without spending the scarce replan budget). Only genuinely blank pages —
      // where the unfocused observe is also empty — stay "absent".
      const unfocused = await guardedObserve(
        stagehand,
        undefined,
        { timeout: STEP_WATCHDOG_MS },
        captureFn
      );
      if (unfocused.length > 0) {
        logger.info(
          `${formatStepPrefix(stepIndex, totalSteps)}: focused probe found 0 candidates but unfocused observe found ${unfocused.length} — treating as present (let cascade resolve)`
        );
        return "present";
      }
      logger.info(
        `${formatStepPrefix(stepIndex, totalSteps)}: probe found 0 candidates (focused and unfocused) — treating as absent (skip cascade, route to replan if required)`
      );
      return "absent";
    }
    logger.info(
      `${formatStepPrefix(stepIndex, totalSteps)}: probe found ${candidates.length} candidate(s)`
    );
    return "present";
  } catch (err) {
    // Bias toward the existing behavior on errors: don't trigger a spurious
    // replan when the probe itself is the broken thing.
    logger.warn(
      `${formatStepPrefix(stepIndex, totalSteps)}: probe threw ${toErrorMessage(err)} — treating as present (cascade will run)`
    );
    return "present";
  }
}

export async function executeStepWithHealing(params: {
  stagehand: Stagehand;
  page: Page;
  step: string;
  /**
   * When true and Stagehand's act+observe finds no candidates, the cascade
   * skips the step cleanly instead of burning through attempts 3-4 and the
   * replan budget. Required steps (default) keep the full 4-attempt healing.
   */
  optional: boolean;
  /**
   * When true, dispatches to the upload primitive (which sets the fixture
   * on the page's <input type=file>) instead of running the cascade. Required
   * for resume-upload widgets that hide the real file input behind styled
   * buttons Stagehand can't click. Set from the flow file's `upload: true`.
   */
  upload: boolean;
  /**
   * When true, treat this step as the canonical submit click for the
   * `submitEndpointPattern` verifier even if it is NOT the last step in
   * the flow. Set from the flow file's `submitStep: true`. AppCast's flow
   * has its Submit click at index 55/328 — without this flag, the pre-
   * submit DOM probe (gated on isFinalStep alone) never fires on the real
   * Submit, so unfilled required fields produce silent submit failures.
   * Site-agnostic: any flow whose canonical submit is mid-list can opt in.
   */
  submitStep: boolean;
  stepIndex: number;
  /**
   * Getter, not a number: a global replan splices new steps into the live plan
   * array mid-run, so the denominator must be read at log time or every line
   * after a replan prints a stale total.
   */
  totalSteps?: () => number;
  phase: string;
  signalCounter: { n: number };
  recentCaptures: string[];
  recentCaptureMeta: { method: string; status: number; url: string }[];
  anthropic: Anthropic | null;
  logger: Logger;
  captureFn?: CaptureFn;
  resumeFixture: { buffer: Buffer; name: string; mimeType: string } | null;
  /**
   * Final-step gate: when both are set, the verifier additionally requires at
   * least one capture in `recentCaptureMeta` whose URL matches the pattern. Lets
   * sites declare "the click that ends the flow must produce a request to
   * /api/.../submit" so the cascade can detect tracking-pixel-only clicks as
   * verification failures and engage the rephrase/replan recovery path
   * instead of declaring victory.
   */
  isFinalStep: boolean;
  submitEndpointPattern: string | null;
  /**
   * DOM-level fallback for the final-step submit gate. If the network
   * capture didn't match `submitEndpointPattern` within the attempt
   * window, the verifier also probes the live DOM for any of these
   * selectors — a match indicates the SPA has reached its submitted /
   * thank-you state even though the underlying POST landed outside the
   * verifier's capture window (debounced submits, batched requests,
   * SPAs that swap the form before the network event records).
   */
  submittedStateSelectors: string[];
  /**
   * When true, the final-step verifier accepts ONLY a `submitEndpointPattern`
   * network capture as proof of submission — DOM-state matches become a
   * tiebreaker, not a standalone fallback. See `RECON_FLOW_FILE_SCHEMA` for
   * the rationale + the SPA failure mode this guards against.
   */
  requireSubmitEndpointMatch: boolean;
  /**
   * Opt-in regex matched against same-window capture request BODIES to trust an
   * interior advance/"Next" step's network signal (see `RECON_FLOW_FILE_SCHEMA`
   * `advanceTransitionBodyPattern`). Null/empty = today's behavior (any
   * network/url/dom signal verifies an advance).
   */
  advanceTransitionBodyPattern: string | null;
  /**
   * URL path fragments that indicate a successful submit transition.
   * Surfaced to the Haiku verifySubmit judge as one of the strong
   * corroborating signals (DOM/URL/title) required for verified=true.
   * Site-supplied via the flow file. Empty array = no URL hints.
   */
  successUrlFragments: string[];
  /**
   * Page-title substrings that indicate a successful submit. Same role as
   * successUrlFragments. Site-supplied via the flow file. Empty = no hints.
   */
  successPageTitleHints: string[];
  /**
   * Hostnames considered "the site's own backend." A 2xx POST/PUT/DELETE
   * to one of these hostnames within the attempt window is a corroborating
   * network signal for the Haiku verifySubmit judge. Site-supplied via the
   * flow file. Empty array means the judge ignores network signals.
   */
  ownBackendHostnames: string[];
  /**
   * Optional site-specific class-name prefixes that wrap form/error
   * state. Surfaced to the Haiku invalid-fields judge as additional
   * structural evidence. Empty array = framework-conventional only.
   */
  knownErrorClassPrefixes: string[];
  /**
   * Site + engine wizard-exit labels. When a "click / advance" step's resolved
   * action names one of these (via isWizardExitAction), the cascade rejects it
   * so an advance step never fires a save-and-exit / cancel / restart control.
   */
  wizardExitButtonLabels: string[];
  /**
   * Live accessor for the running count of suppressed Stagehand AISDK
   * elementId-regex errors this session (see
   * `BrowserSession.getSuppressedAisdkElementIdErrorCount`). Corroborating
   * evidence only when a phantom click is detected — logged alongside the
   * escalation, never a trigger by itself (a nonzero count alone is too weak
   * a signal across a whole run). Omitted or absent on providers that don't
   * expose it (e.g. Steel); the phantom-click detection is unaffected either
   * way since it is keyed on the pre/post snapshot delta.
   */
  getSuppressedAisdkElementIdErrorCount?: () => number;
  /**
   * Optional accumulator the cascade pushes onto when this step verifies.
   * Lets the main loop maintain a short cross-step trajectory of `verifiedBy`
   * signals (network / url / dom / submitted-state-dom) which is then
   * surfaced to the replan prompt as "PRIOR STEP TRAJECTORY" so the LLM
   * can tell whether the page has been visibly transitioning vs. staying
   * static. When omitted, the cascade behaves identically — purely
   * additive instrumentation.
   */
  trajectory?: { stepIndex: number; verifiedBy: AttemptRecord["verifiedBy"] }[];
  /**
   * Persistence seam for the terminal failure dump. When the probe finds no
   * candidates or the cascade exhausts every attempt, the engine hands the
   * dump payload to this callback and threads its returned path into the
   * thrown {@link StepVerificationError} message. Keeps this leaf module free
   * of the recon CLI's on-disk `step-failures/` layout; the CLI passes its own
   * `dumpStepFailure`. When omitted, the dump is skipped and the path is null.
   */
  onStepFailure?: (params: {
    stepIndex: number;
    phase: string;
    originalStep: string;
    attempts: AttemptRecord[];
    finalObserve: Action[];
    pageUrl: string;
    pageTitle: string;
    recentCaptures: string[];
    bodyOuterHtml: string | null;
    unfocusedObserve: Action[];
  }) => string | null;
}): Promise<"completed" | "skipped"> {
  const {
    stagehand,
    page,
    step,
    optional,
    upload,
    submitStep,
    stepIndex,
    totalSteps,
    phase,
    signalCounter,
    recentCaptures,
    recentCaptureMeta,
    anthropic,
    logger,
    captureFn,
    resumeFixture,
    isFinalStep,
    submitEndpointPattern,
    submittedStateSelectors,
    requireSubmitEndpointMatch,
    advanceTransitionBodyPattern,
    successUrlFragments,
    successPageTitleHints,
    ownBackendHostnames,
    knownErrorClassPrefixes,
    wizardExitButtonLabels,
    getSuppressedAisdkElementIdErrorCount,
    trajectory,
    onStepFailure,
  } = params;
  // Read-once to suppress "unused" — knownErrorClassPrefixes is threaded
  // through executeStepWithHealing's signature so the cascade has it in
  // scope when the invalid-fields judge migration (Task #43) lands. The
  // judges already exist (src/lib/llm/judges/invalid-fields.ts); the
  // remaining work is wiring them into extractLivePageFormEvidence.
  void knownErrorClassPrefixes;
  // requireSubmitEndpoint gates the Haiku verifySubmit judge AND the pre-
  // submit DOM probe (probeFormValidityBeforeSubmit). We retain the
  // submitEndpointPattern field as a hint (some downstream code paths still
  // read the original pattern to feed extractSubmitFailureEvidence with a
  // submit-specific filter), but the verifier itself no longer treats the
  // pattern as a hard regex check — verifySubmitWithLLM reasons over
  // multi-signal evidence with strict prompting instead.
  //
  // Gate accepts (isFinalStep || submitStep): flows whose canonical Submit
  // click lives mid-list (e.g. AppCast's flow has Submit at step 55/328 with
  // 273 post-submit verification steps) opt in via the per-step
  // `submitStep: true` flag in the flow file. Without this opt-in, the pre-
  // submit DOM probe gated solely on `isFinalStep` never fires on the real
  // Submit, and unfilled required fields produce silent submit failures
  // (verified 2026-06-15 on UVA Verona telemetry). Site-agnostic: any flow
  // whose submit is mid-list can mark its submit step explicitly.
  const requireSubmitEndpoint = (isFinalStep || submitStep) && submitEndpointPattern !== null;
  const attempts: AttemptRecord[] = [];
  const triedSelectors: string[] = [];
  const failureReasons: string[] = [];

  // When the flow file marks the step `upload: true`, dispatch to the
  // site-agnostic upload primitive (setInputFiles + network-signal verify).
  // On success, the step is fully handled — no cascade needed. On failure
  // (no file input on the page, network never fires), we fall through to
  // the existing cascade.
  if (
    await tryUploadPrimitive({
      page,
      isUploadStep: upload,
      fixture: resumeFixture,
      logger,
      signalCounter,
      recentCaptureMeta,
    })
  ) {
    logger.info(`${formatStepPrefix(stepIndex, totalSteps)} resolved by upload primitive`);
    trajectory?.push({ stepIndex, verifiedBy: "network" });
    return "completed";
  }

  // When the step is a native-<select> dropdown selection, answer it directly
  // in the DOM ahead of the cascade. Critical for MuiNativeSelect/tabindex=-1
  // dropdowns (HCA/Talemetry) that Stagehand observe can't surface — the
  // cascade would otherwise skip them ("no candidates") and leave a required
  // question unanswered. No-op (returns false → falls through) when the step
  // isn't a single-dropdown select or no option matches.
  if (await trySelectPrimitive({ page, instruction: step, logger, anthropic, captureFn })) {
    logger.info(`${formatStepPrefix(stepIndex, totalSteps)} resolved by select primitive`);
    trajectory?.push({ stepIndex, verifiedBy: "dom" });
    return "completed";
  }

  // When the step is a "select 'X'" against a multi-select CHECKBOX group
  // (c-MultiCheckboxInput) rather than a <select> — Talemetry renders some
  // screening questions this way — answer it directly in the DOM. Runs AFTER
  // trySelectPrimitive (which handles <select> and no-ops on checkbox-only
  // pages). No-op (falls through) when there's no checkbox group or no match.
  if (await tryCheckboxPrimitive({ page, instruction: step, logger, anthropic, captureFn })) {
    logger.info(`${formatStepPrefix(stepIndex, totalSteps)} resolved by checkbox primitive`);
    trajectory?.push({ stepIndex, verifiedBy: "dom" });
    return "completed";
  }

  // When the step is a single-choice RADIO answer ("Click the 'Yes' answer for
  // the question '…'"), commit it directly in the DOM. Runs AFTER select/
  // checkbox (which own their verbs) and BEFORE the cascade, so radios never
  // reach the observe cascade's el.click() fallback that fails to commit MUI/
  // React controlled state (the HCA Basic-Info Step-2 wall). No-op (falls
  // through) when there's no radio group or no confident option match.
  if (await tryRadioPrimitive({ page, instruction: step, logger, anthropic, captureFn })) {
    logger.info(`${formatStepPrefix(stepIndex, totalSteps)} resolved by radio primitive`);
    trajectory?.push({ stepIndex, verifiedBy: "dom" });
    return "completed";
  }

  // On a CATCH-ALL step ("for any remaining … question"), fill every
  // required-but-empty native <select> — including MuiNativeSelect dropdowns
  // (tabindex=-1) that Stagehand observe can't see and that no concrete flow
  // step targets (requisition-specific specialty questions). Runs only on the
  // catch-all (parseSelectStep returns null there, so trySelectPrimitive above
  // skipped it) and no-ops when the page has no required-empty select.
  if (
    await tryFillRequiredSelectsPrimitive({ page, instruction: step, logger, anthropic, captureFn })
  ) {
    logger.info(`${formatStepPrefix(stepIndex, totalSteps)} resolved by required-select primitive`);
    trajectory?.push({ stepIndex, verifiedBy: "dom" });
    return "completed";
  }

  // Snapshot the capture-meta tail length at step entry. The probe-absent
  // legitimate-transition check (below) scans captures landed during THIS
  // step's processing — earlier-step transitions don't count.
  const stepStartMetaLength = recentCaptureMeta.length;

  // Page-state probe BEFORE the cascade. When the page doesn't have any
  // candidate matching the step's instruction we either skip cleanly
  // (optional) or escalate straight to replan (required) — far cheaper than
  // burning 4 attempts on a page that clearly isn't the right one.
  const probeResult = await probeStepBeforeAttempts({
    stagehand,
    step,
    stepIndex,
    totalSteps,
    logger,
    captureFn,
  });
  if (probeResult === "absent") {
    if (optional) {
      // Don't fast-skip when the page plainly has a required, still-empty
      // control this step was meant to answer (SPA hydration lag / observe
      // can't resolve the widget) — skipping would leave a required field empty
      // and silently doom the later submit. Fall through to the cascade instead.
      if (await hasUnfilledRequiredControlForStep(page, step)) {
        logger.info(
          `${formatStepPrefix(stepIndex, totalSteps)} probe-absent but a required unfilled control matches the question; NOT skipping (escalating to cascade)`
        );
      } else {
        logger.info(
          `${formatStepPrefix(stepIndex, totalSteps)} skipped (optional, probe found no candidates)`
        );
        return "skipped";
      }
    }
    // Telemetry-driven legitimate-transition detection. When the page
    // already advanced (a 3xx redirect or successful non-tracking POST
    // landed in the same-window capture meta), the step's "absent" state
    // reflects expected progress, not a failure — replan would just be
    // noise. Skip cleanly and let the next iteration probe the post-
    // transition page.
    const transitionUrl = findRecentPageTransition({
      recentCaptureMeta,
      preMetaLength: stepStartMetaLength,
    });
    if (transitionUrl !== null) {
      logger.info(
        `${formatStepPrefix(stepIndex, totalSteps)} skipped (probe absent but recent transition detected: ${transitionUrl})`
      );
      trajectory?.push({ stepIndex, verifiedBy: "url" });
      return "completed";
    }
    // Telemetry-driven backend-error detection. If the same-window capture
    // meta contains a 5xx response from the configured submit endpoint,
    // the backend errored — no rephrase or replan can heal a server crash.
    // Fail-fast so the runner surfaces the diagnostic instead of burning
    // budget on retries that will fail identically.
    const backendErrorUrl = findRecentBackendError({
      recentCaptureMeta,
      preMetaLength: stepStartMetaLength,
      ownBackendHostnames,
    });
    if (backendErrorUrl !== null) {
      logger.error(
        `${formatStepPrefix(stepIndex, totalSteps)} backend error detected (submit endpoint returned 5xx: ${backendErrorUrl}); aborting cascade`
      );
      throw new StepVerificationError(
        `${formatStepPrefix(stepIndex, totalSteps)} (${step.slice(0, 60)}) backend 5xx at ${backendErrorUrl} — unrecoverable`,
        "backend-error-unrecoverable"
      );
    }
    // Capture diagnostics + write a failure dump BEFORE throwing so the
    // global replan path's `readFailureDumpEvidence` can populate the
    // prompt's CURRENTLY VISIBLE / UNFOCUSED OBSERVE / PAGE BODY HTML
    // sections. Without this, the LLM-replan receives empty diagnostic
    // data, returns "repeat the failed step", and the next probe-absent
    // burns the replan budget in seconds. Embed `see <path>` in the
    // throw message so the existing regex at the dispatcher (`/see
    // (\/[^\s]+)$/`) extracts dumpPath for replanRemainingFlow.
    const pageTitle = await page.title().catch(() => "");
    const bodyOuterHtmlRaw = await page
      .evaluate("document.body ? document.body.outerHTML : null")
      .catch(() => null);
    const bodyOuterHtml =
      typeof bodyOuterHtmlRaw === "string" ? bodyOuterHtmlRaw.slice(0, 100_000) : null;
    const unfocusedObserve = await guardedObserve(
      stagehand,
      undefined,
      { timeout: STEP_WATCHDOG_MS },
      captureFn
    ).catch(() => [] as Action[]);
    const dumpPath =
      onStepFailure?.({
        stepIndex,
        phase,
        originalStep: step,
        attempts: [],
        finalObserve: [],
        pageUrl: page.url(),
        pageTitle,
        recentCaptures,
        bodyOuterHtml,
        unfocusedObserve,
      }) ?? null;
    throw new StepVerificationError(
      `${formatStepPrefix(stepIndex, totalSteps)} (${step.slice(0, 60)}) probe found no candidates on page${dumpPath ? `; see ${dumpPath}` : ""}`,
      "probe-absent"
    );
  }

  // Pre-submit form-validity probe. Fires on the canonical submit step
  // (either the final flow step OR a step explicitly flagged `submitStep:
  // true` in the flow file) when the flow declared a submitEndpointPattern.
  // Finds form controls still marked ng-invalid
  // (or similar framework markers) and surfaces them as structured
  // failureReasons before attempt 1. The cascade still runs — the probe
  // is evidence-only — but the LLM-rephrase and LLM-replan prompts now
  // start with a concrete diagnosis instead of having to reverse-engineer
  // "no observable effect."
  //
  // The classic trigger: a downstream step's network call causes a
  // framework re-render that wipes an earlier-filled value back to empty.
  // The submit click then silently fails validation and the cascade can't
  // tell what's wrong from the DOM excerpt alone.
  // Pre-submit ng-invalid count: side-effect-free baseline read BEFORE the
  // form-validity auto-picker runs. The early-exit predicate compares this
  // to the post-attempt-1 count to detect "the click revealed NEW required
  // fields" — a state attempts 2-5 mathematically can't clear.
  const preSubmitInvalidCount = requireSubmitEndpoint ? await countNgInvalidContainers(page) : 0;
  if (requireSubmitEndpoint) {
    const invalidControls = await probeFormValidityBeforeSubmit({
      page,
      stepIndex,
      totalSteps,
      logger,
    });
    for (const c of invalidControls) {
      let reason: string;
      if (c.autoFilled !== null) {
        // The probe took action — surface what it did so the cascade's
        // self-heal can persist this as an explicit flow step on the
        // next replan. This is the signal the user explicitly asked
        // for: "surface any missing values so that recon can self heal
        // the recon-flow.json too."
        reason = `auto-filled: '${c.label}' ${c.autoFilled.action} → '${c.autoFilled.value}' to clear ng-invalid state — consider adding an explicit step in the flow file for this field`;
      } else {
        const emptyMarker = c.emptyOrUnchecked ? "empty/unchecked" : "non-empty but invalid";
        reason = `pre-submit: '${c.label}' is ${emptyMarker} (${c.classSignature || "ng-invalid"}); fill or correct before clicking submit`;
      }
      failureReasons.push(reason);
      // Synthesize a pre-attempt record so the dump's `attempts[]` array
      // (which readFailureDumpEvidence reads to build recentFailureReasons)
      // includes the warning even when no actual attempt has run yet.
      // Snapshot fields are best-effort: pre/post are the same since no
      // action ran. resolvedMethod=null marks this as evidence-only.
      const emptyPre: StepSnapshot = {
        networkCount: signalCounter.n,
        url: page.url(),
        bodyHtmlLength: 0,
        visibleTextSignature: "",
      };
      attempts.push({
        attempt: 0,
        technique: "act-string",
        instruction: null,
        triedSelectors: [],
        actResultSuccess: null,
        actResultDescription: null,
        errorMessage: reason,
        pre: emptyPre,
        post: emptyPre,
        resolvedMethod: null,
        resolvedArguments: null,
        verifiedBy: null,
        phantomClickVerdict: null,
      });
    }
    // Brief settle window after auto-picks so Angular's change-detection
    // and any downstream API calls (postal_code_geocoder, interruption_check,
    // ...) finish before the cascade clicks submit. Empirically zone.js
    // change detection completes in <250ms after a programmatic value+change
    // dispatch; 500ms covers the long tail including downstream XHRs.
    if (invalidControls.some((c) => c.autoFilled !== null)) {
      await page.waitForTimeout(500);
    }
  }

  // Set after attempt 1: this is a wizard-advance step whose first attempt did
  // NOT move the wizard forward. Read at the top of attempts 2-4 to skip the
  // proven-dead re-observe/re-click techniques (see shouldSkipTechnique).
  let advanceUnmovedAfterAttempt1 = false;
  // Set after attempt 1: Stagehand reported success but pre/post shows zero
  // observable effect (see classifyPhantomClick). Reroutes attempt 2 to
  // deep-submit-locator instead of observe-act, since re-resolving via the
  // same light-DOM view cannot reach a target the resolver can't see.
  let phantomClickAfterAttempt1 = false;
  for (let attempt = 1; attempt <= MAX_STEP_ATTEMPTS; attempt++) {
    // Telemetry-driven technique-skip: when a cascade technique's
    // preconditions cannot be met by the prior attempts' state, running
    // it would burn the attempt slot without exercising new behaviour.
    // Skip to the next iteration so the cascade reaches its higher-value
    // techniques faster.
    if (attempt > 1) {
      const wouldBeTechnique: AttemptRecord["technique"] =
        attempt === 2
          ? phantomClickAfterAttempt1
            ? "deep-submit-locator"
            : "observe-act"
          : attempt === 3
            ? "structured-click"
            : attempt === 4
              ? "observe-act-exclude"
              : "llm-rephrase";
      const decision = shouldSkipTechnique({
        technique: wouldBeTechnique,
        priorAttempts: attempts.map((a) => ({
          technique: a.technique,
          triedSelectors: a.triedSelectors,
          errorMessage: a.errorMessage,
        })),
        advanceUnmovedAfterAttempt1,
        phantomClickAfterAttempt1,
      });
      if (decision.skip) {
        logger.info(
          `${formatStepPrefix(stepIndex, totalSteps)} attempt ${attempt} (${wouldBeTechnique}) skipped: ${decision.reason}`
        );
        failureReasons.push(`attempt ${attempt} skipped: ${decision.reason}`);
        continue;
      }
    }
    if (attempt > 1) {
      await page.waitForTimeout(attempt * ATTEMPT_BACKOFF_MS);
    }

    const pre = await snapshotPage(page, signalCounter);
    // Snapshot the meta-tail length so the final-step pattern gate can scope
    // its URL scan to captures added DURING this attempt (not historical
    // tail from earlier steps).
    const preMetaLength = recentCaptureMeta.length;
    // Same idea for the interior-advance body gate, but scoped by the monotonic
    // capture INDEX (not the array length): the body gate scans capture files on
    // disk for entries indexed after this point, which is eviction-proof when
    // >RECENT_CAPTURES_WINDOW captures flood during the step.
    const preCaptureIdx = latestCaptureIndex(recentCaptures);
    const record: AttemptRecord = {
      attempt,
      technique: "act-string",
      instruction: null,
      triedSelectors: [],
      actResultSuccess: null,
      actResultDescription: null,
      errorMessage: null,
      pre,
      post: pre,
      resolvedMethod: null,
      resolvedArguments: null,
      verifiedBy: null,
      phantomClickVerdict: null,
    };

    // First resolved action from Stagehand's `act` result — used to decide
    // whether this attempt's signal should come from the network/URL pair or
    // from DOM re-read. Captured here so both branches of the cascade write to it.
    let resolvedAction: Action | null = null;

    try {
      if (attempt === 1) {
        record.technique = "act-string";
        record.instruction = step;
        const result = await guardedAct(stagehand, step, { timeout: STEP_WATCHDOG_MS }, captureFn);
        record.actResultSuccess = result.success;
        record.actResultDescription = result.actionDescription;
        // Deny-list guard (post-hoc): attempt-1 act resolves internally, so we
        // can't block the click, but we refuse to COUNT a wizard-exit control as
        // success — don't set resolvedAction, force failure — so the cascade
        // doesn't treat "clicked Cancel/Continue-Later" as a completed step.
        // (If the click already restarted the wizard, the loop's restart-signal
        // detection aborts the run regardless.)
        if (
          isWizardExitAction(result.actionDescription, wizardExitButtonLabels) ||
          result.actions?.some((a) => isWizardExitAction(a.description, wizardExitButtonLabels))
        ) {
          record.errorMessage = `refused wizard-exit control: "${result.actionDescription.slice(0, 60)}"`;
          record.actResultSuccess = false;
          for (const action of result.actions ?? []) {
            if (action.selector) triedSelectors.push(action.selector);
          }
        } else {
          for (const action of result.actions ?? []) {
            if (action.selector) triedSelectors.push(action.selector);
            if (!resolvedAction) resolvedAction = action;
          }
        }
      } else if (attempt === 2 && phantomClickAfterAttempt1) {
        // Deep submit-control locator: attempt 1 phantom-clicked (Stagehand
        // reported success but pre/post showed zero effect), so the target is
        // almost certainly unreachable via document.querySelectorAll — most
        // likely rendered inside an open shadow root by a web-component /
        // framework-native submit control (see recon-submit-phantom-click bug
        // report). Rank every submit-shaped candidate the deep traversal can
        // reach and click the top-ranked one; the ranking already excludes
        // Back/Cancel/Save-draft-shaped controls, so a false-positive submit
        // click cannot fire.
        record.technique = "deep-submit-locator";
        const ranked = (await page
          .evaluate(buildRankSubmitCandidatesExpr())
          .catch(() => [] as SubmitCandidate[])) as SubmitCandidate[];
        if (ranked.length === 0) {
          record.errorMessage = "deep-submit-locator: no submit-shaped candidate found";
        } else {
          // biome-ignore lint/style/noNonNullAssertion: guarded by the length check above
          const top = ranked[0]!;
          record.instruction = `deep-submit-locator: ${top.tag} "${top.accessibleName}" (tier ${top.tier})`;
          record.triedSelectors = [`deep-index:${top.deepIndex}`];
          triedSelectors.push(`deep-index:${top.deepIndex}`);
          const clickResult = (await page
            .evaluate(buildClickByDeepIndexExpr(top.deepIndex))
            .catch(() => ({ clicked: false }))) as { clicked: boolean };
          record.actResultSuccess = clickResult.clicked;
          record.actResultDescription = clickResult.clicked
            ? `deep-submit-locator clicked ${top.tag} "${top.accessibleName}"`
            : "deep-submit-locator: candidate vanished before click (deepIndex stale)";
          if (clickResult.clicked) {
            // Synthesize a click action so downstream verification (network /
            // url / dom) treats this exactly like any other resolved click.
            resolvedAction = {
              selector: `deep-index:${top.deepIndex}`,
              description: record.actResultDescription,
              method: "click",
            };
          } else {
            record.errorMessage = record.actResultDescription;
          }
        }
      } else if (attempt === 2 || attempt === 4) {
        record.technique = attempt === 2 ? "observe-act" : "observe-act-exclude";
        const observeOptions =
          attempt === 4 && triedSelectors.length > 0
            ? { ignoreSelectors: [...triedSelectors], timeout: STEP_WATCHDOG_MS }
            : { timeout: STEP_WATCHDOG_MS };
        const candidates = await guardedObserve(stagehand, step, observeOptions, captureFn);
        if (candidates.length === 0) {
          record.errorMessage = "observe returned no candidates";
          // Optional-step short-circuit: when attempt 2 confirms no candidates
          // match AND the step was marked optional in the flow, skip cleanly.
          // We require attempt 1 to also have returned no actions (no resolved
          // selector — `triedSelectors` only fills when act/observe resolved
          // something) so an optional step that did find a target but failed
          // to verify still runs the full healing cascade.
          //
          // This fast-skip is essential: a genuinely-absent optional step
          // (e.g. a "dismiss modal" step on a page with no modal) must NOT run
          // the full 5-attempt cascade + a global replan — that wastes minutes
          // and drains the replan budget. Present-but-hard fields succeed at
          // attempt 1 (act-string / the DOM-direct primitives) on their own, so
          // they don't rely on suppressing this skip.
          if (optional && attempt === 2 && triedSelectors.length === 0) {
            // Same escalation guard as the probe-absent skip: if a required,
            // still-empty control matching this step's question is present,
            // don't fast-skip — let the healing cascade continue so the
            // required field gets answered instead of silently doomed.
            if (await hasUnfilledRequiredControlForStep(page, step)) {
              logger.info(
                `${formatStepPrefix(stepIndex, totalSteps)} no candidates after act+observe but a required unfilled control matches; NOT skipping (continuing cascade)`
              );
            } else {
              record.verifiedBy = null;
              attempts.push(record);
              logger.info(
                `${formatStepPrefix(stepIndex, totalSteps)} skipped (optional, no candidates after act+observe)`
              );
              return "skipped";
            }
          }
        } else {
          // biome-ignore lint/style/noNonNullAssertion: this else-branch runs only when candidates.length !== 0
          const target = candidates[0]!;
          // Deny-list guard: never act on a wizard-exit control (save-and-exit,
          // cancel, restart) for a click/advance step. Record it as tried (so a
          // re-observe with ignoreSelectors surfaces a different candidate) and
          // fail this attempt instead of firing a destructive click.
          if (isWizardExitAction(target.description, wizardExitButtonLabels)) {
            record.errorMessage = `refused wizard-exit control: "${target.description.slice(0, 60)}"`;
            triedSelectors.push(target.selector);
            record.triedSelectors = [target.selector];
            attempts.push(record);
            failureReasons.push(record.errorMessage);
            logger.info(
              `${formatStepPrefix(stepIndex, totalSteps)} attempt ${attempt}: ${record.errorMessage}`
            );
            continue;
          }
          record.instruction = target.description;
          triedSelectors.push(target.selector);
          record.triedSelectors = [target.selector];
          const result = await guardedAct(
            stagehand,
            target,
            { timeout: STEP_WATCHDOG_MS },
            captureFn
          );
          record.actResultSuccess = result.success;
          record.actResultDescription = result.actionDescription;
          // observe(...)[0] is what Stagehand acted on; use it directly when
          // result.actions[] is empty (some Stagehand paths don't echo it back).
          resolvedAction = result.actions?.[0] ?? target;

          // Stagehand bug #1249 (OPEN as of 2026-06-14): act("fill") on
          // HTML5 <input type="date|time|datetime-local|month|week">
          // returns success but the value doesn't actually land in the
          // DOM. Standard React/Angular controlled-component workaround:
          // set the value via the native HTMLInputElement.prototype
          // setter + dispatch input/change events. Helper returns null
          // for non-date inputs (no-op), so the happy path for regular
          // inputs is byte-identical to today.
          //
          // H' Change 2: drop the `result.success === true` precondition.
          // Today's smoke (run 1781485435455, step 251) showed Stagehand
          // returns success=false on date inputs because its internal
          // Haiku LLM hits AI_TypeValidationError when formulating the
          // fill action — but `target` (the observe-resolved candidate)
          // still has the right xpath + arguments. Use `target` directly
          // so the helper fires even when guardedAct technically failed.
          if (
            target.method === "fill" &&
            Array.isArray(target.arguments) &&
            target.arguments.length > 0
          ) {
            const fillValue = target.arguments[0];
            if (typeof fillValue === "string") {
              const dateFill = await fillHtml5DateTimeInput(page, target.selector, fillValue);
              if (dateFill !== null) {
                record.errorMessage = dateFill.filled
                  ? `html5-date-fallback: filled ${dateFill.inputType}="${dateFill.postValue}"`
                  : `html5-date-fallback: failed to fill ${dateFill.inputType} (post=${dateFill.postValue})`;
                // Override the act result based on the deterministic fill
                // outcome — the helper bypasses Stagehand's schema-error
                // failure mode by writing directly via the native setter.
                if (dateFill.filled) {
                  record.actResultSuccess = true;
                  resolvedAction = target;
                }
              } else {
                // Fix I: not a date input — verify the regular fill landed.
                // Catches silent-value-rejection cases (HTML5 type validation
                // on number/email/url/tel inputs, framework-controlled-
                // component rejection, masked-input library reformatting).
                // Generic primitive that the verifier's existing signals
                // (network/url/dom/htmlDelta/textChanged) miss.
                const readback = await verifyFillReadback(page, target.selector, fillValue);
                if (readback !== null) {
                  if (readback.outcome === "rejected") {
                    record.errorMessage = `fill-value-rejected: tried "${fillValue.slice(0, 60)}" on <${readback.tag}>; element value remains empty (silent rejection — HTML5 type validation, framework controlled-component, or masked-input library)`;
                    record.actResultSuccess = false;
                  } else if (readback.outcome === "differs") {
                    logger.info(
                      `${formatStepPrefix(stepIndex, totalSteps)} fill-value-differs: tried "${fillValue.slice(0, 60)}" got "${readback.postValue.slice(0, 60)}" (framework reformatted)`
                    );
                  }
                }
              }
            }
          }
        }
      } else if (attempt === 3) {
        // Structured-click cascade. Site-agnostic recovery for steps where
        // Stagehand's CDP click landed on the visible UI but the underlying
        // checkable <input> didn't actually toggle — the common case is a
        // <label>-wrapped HIDDEN <input type="radio|checkbox">, where the
        // browser's default label-click action does NOT toggle .checked for
        // hidden inputs (Bootstrap, Tailwind, plain HTML labels-control,
        // Angular Material's mat-radio-button, PrimeNG's p-radioButton, and
        // custom Angular components like AppCast's app-radio-button all fit
        // this shape). The framework's FormControl/state listens on the
        // input's `change` event, which never fires when the visible click
        // never reaches a clickable input — so the form stays invalid even
        // though the visual state looks correct.
        //
        // Strategy: take the most-recently-tried selector, walk to a nearby
        // checkable input (descendant / closest('label') / closest(framework
        // wrapper)), then try three CLICK targets in order — label[for=id],
        // closest('label'), closest(framework-wrapper) — checking
        // input.checked after each. The clicks fire via DOM element.click()
        // (not CDP) so they go through the page's own event pipeline and
        // engage framework reactivity in zone/synthetic-event handlers.
        //
        // No-op when the resolved selector doesn't map to a checkable input
        // shape (real button/link clicks, fills, etc.) — those steps fall
        // through to attempts 4 + 5 with the cascade attempt slot "wasted"
        // only in the sense of a fast skip + STEP_PAUSE_MS.
        record.technique = "structured-click";
        // resolvedAction is declared `Action | null` outside this branch
        // (line above the for-loop). TS narrows it to `null` inside the
        // attempt-3 branch because no code path within this attempt's
        // try-block has assigned to it yet — explicit cast keeps the read
        // type-safe without restructuring the outer declaration.
        const prior = resolvedAction as Action | null;
        const lastSelector = triedSelectors[triedSelectors.length - 1] ?? prior?.selector ?? null;
        const xpath = lastSelector ? xpathBody(lastSelector) : null;
        if (!xpath) {
          record.errorMessage = "structured-click: no xpath from prior attempt";
        } else {
          // Trust boundary: xpath comes from Stagehand's own resolved
          // selector during a prior attempt of THIS step, not from URL
          // / user input. JSON.stringify produces a safe JS string literal
          // for the composed page.evaluate expression.
          const probeExpr = `(() => {
            const r = document.evaluate(${JSON.stringify(xpath)}, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
            const start = r.singleNodeValue;
            if (!start) return { resolved: false };
            const isCheckable = (n) => n && n.tagName === "INPUT" && (n.type === "radio" || n.type === "checkbox");
            // Find the checkable input reachable from the start element.
            // Order: itself → ancestor label → ancestor framework wrapper →
            // first descendant.
            let input = isCheckable(start) ? start : null;
            if (!input) {
              const ancLabel = start.closest ? start.closest("label") : null;
              if (ancLabel) input = ancLabel.querySelector('input[type="radio"], input[type="checkbox"]');
            }
            if (!input) {
              const ancWrapper = start.closest ? start.closest("app-radio-button, app-checkbox, mat-radio-button, mat-checkbox, p-radioButton, p-checkbox, [role='radiogroup'], fieldset") : null;
              if (ancWrapper) input = ancWrapper.querySelector('input[type="radio"], input[type="checkbox"]');
            }
            if (!input && start.querySelector) {
              // Bound the descendant search to the nearest single-question
              // container so a broad start element (form, <ol>, fieldset
              // wrapping the whole form) cannot reach the first radio
              // anywhere in the form — which is almost always "Yes" of an
              // unrelated question, and would silently flip a previously-
              // answered radio with an unrelated instruction. If the
              // bounded scope returns null the cascade falls through to
              // safer techniques rather than picking a wrong target.
              const scope = start.closest
                ? start.closest("li, app-radio-group, app-checkbox-group, mat-radio-group, fieldset[role='radiogroup'], [role='radiogroup']")
                : null;
              if (scope) {
                input = scope.querySelector('input[type="radio"], input[type="checkbox"]');
              }
            }
            if (!input) return { resolved: true, isCheckable: false };
            // Strategy 1: label[for=id]
            if (input.id) {
              const lbl = document.querySelector('label[for="' + CSS.escape(input.id) + '"]');
              if (lbl && lbl.scrollIntoView) {
                lbl.scrollIntoView({ block: "center", inline: "center" });
                lbl.click();
                if (input.checked === true) return { resolved: true, isCheckable: true, checked: true, strategyUsed: "label-for" };
              }
            }
            // Strategy 2: input.closest("label")
            const parentLbl = input.closest("label");
            if (parentLbl && parentLbl.scrollIntoView) {
              parentLbl.scrollIntoView({ block: "center", inline: "center" });
              parentLbl.click();
              if (input.checked === true) return { resolved: true, isCheckable: true, checked: true, strategyUsed: "parent-label" };
            }
            // Strategy 3: closest framework wrapper
            const wrap = input.closest("app-radio-button, app-checkbox, mat-radio-button, mat-checkbox, p-radioButton, p-checkbox");
            if (wrap && wrap.scrollIntoView) {
              wrap.scrollIntoView({ block: "center", inline: "center" });
              wrap.click();
              if (input.checked === true) return { resolved: true, isCheckable: true, checked: true, strategyUsed: "wrapper" };
            }
            return { resolved: true, isCheckable: true, checked: false, strategyUsed: null };
          })()`;
          try {
            const result = await page.evaluate(probeExpr);
            if (result !== null && typeof result === "object" && "resolved" in result) {
              const probe = result as {
                resolved: boolean;
                isCheckable?: boolean;
                checked?: boolean;
                strategyUsed?: string | null;
              };
              if (probe.resolved !== true || probe.isCheckable !== true) {
                record.errorMessage =
                  "structured-click: no checkable input reachable from prior selector";
              } else if (probe.checked === true && probe.strategyUsed) {
                record.instruction = `structured-click via ${probe.strategyUsed}`;
                record.actResultSuccess = true;
                record.actResultDescription = `structured-click cascade clicked ${probe.strategyUsed} → input.checked=true`;
                // Synthesize a click action so verifyDomEffect downstream
                // routes through its radio/checkbox isChecked() path.
                resolvedAction = {
                  // biome-ignore lint/style/noNonNullAssertion: reached only via the !xpath else-branch, and xpath is truthy iff lastSelector is (line 5616)
                  selector: lastSelector!,
                  description: "structured-click",
                  method: "click",
                };
              } else {
                record.errorMessage =
                  "structured-click: cascade exhausted (no strategy left input.checked)";
              }
            } else {
              record.errorMessage = "structured-click: probe returned unexpected shape";
            }
          } catch (err) {
            record.errorMessage = `structured-click: probe threw ${toErrorMessage(err)}`;
          }
        }
      } else {
        record.technique = "llm-rephrase";
        if (!anthropic) {
          record.errorMessage = "no anthropic client (bedrock-only deployment); skipping rephrase";
        } else if (hasBillingErrorBeenLogged()) {
          // Telemetry-driven skip: when Anthropic billing has already been
          // flagged FATAL for this process, every subsequent rephrase call
          // will fail identically. Skip the observe + evidence-extraction
          // + LLM round-trip and let the cascade exhaust cleanly so the
          // global replan path can decide whether replans are still viable
          // (the replan helper has the same guard via its own catch path).
          record.errorMessage =
            "anthropic billing exhausted (FATAL_BILLING already logged); skipping rephrase";
        } else {
          const candidates = await guardedObserve(
            stagehand,
            step,
            { timeout: STEP_WATCHDOG_MS },
            captureFn
          ).catch(() => [] as Action[]);
          // Fetch live-page evidence so the rephrase prompt can reason about
          // form state, not just observe candidates. Mirrors the same
          // extraction the cascade-exhaust dump path already does.
          const livePageEvidence = await extractLivePageFormEvidence(page, {
            client: anthropic,
            knownErrorClassPrefixes,
            captureFn,
          });
          // Unfocused observe so the rephrase prompt can see ambient UI
          // like modal Save/Close buttons that the focused candidates
          // (filtered by the failed step's instruction) would hide.
          const unfocused = await guardedObserve(
            stagehand,
            undefined,
            { timeout: STEP_WATCHDOG_MS },
            captureFn
          ).catch(() => [] as Action[]);
          const submitFailureList = extractSubmitFailureEvidence(
            recentCaptures,
            ownBackendHostnames
          );
          const gaEventList = extractGaEventEvidence(recentCaptures);
          const priorAttemptsForPrompt = attempts.map((a, i) => ({
            technique: a.technique,
            instruction: a.instruction,
            verdict: a.errorMessage ?? failureReasons[i] ?? null,
          }));
          const rephrased = await rephraseWithLLM(
            anthropic,
            step,
            triedSelectors,
            candidates,
            failureReasons,
            captureFn,
            livePageEvidence,
            unfocused,
            submitFailureList,
            priorAttemptsForPrompt,
            gaEventList
          );
          if (!rephrased) {
            record.errorMessage = "llm declined to rephrase or returned outcome=impossible";
          } else {
            record.instruction = rephrased;
            const result = await guardedAct(
              stagehand,
              rephrased,
              { timeout: STEP_WATCHDOG_MS },
              captureFn
            );
            record.actResultSuccess = result.success;
            record.actResultDescription = result.actionDescription;
            for (const action of result.actions ?? []) {
              if (action.selector) triedSelectors.push(action.selector);
              if (!resolvedAction) resolvedAction = action;
            }
          }
        }
      }
    } catch (err) {
      const cause = err instanceof Error && err.cause instanceof Error ? err.cause.message : null;
      record.errorMessage = `${toErrorMessage(err)}${cause ? ` (cause: ${cause})` : ""}`;
      logBillingErrorIfPresent(err);
    }

    // Fast-skip: attempt 1 (act-string) failed to resolve any actionable
    // element — either Stagehand threw and our catch above stored the
    // errorMessage, or Stagehand returned `{success: false, actions: []}`
    // without throwing (its internal self-heal couldn't recover, typically
    // when Haiku's elementId response fails the regex schema at
    // node_modules/.../stagehand/dist/esm/lib/inference.js:147 + :240).
    // In either case resolvedAction is null, so the rest of this attempt
    // body — snapshotPage, verifyDomEffect, the verifier gates below —
    // cannot produce a positive signal: verified is forced false and the
    // cascade always falls through to attempt 2. Skip the wasted ~2-3s
    // of timeout + snapshot work and let the cascade try observe-act.
    if (attempt === 1 && resolvedAction === null) {
      attempts.push(record);
      const reason = record.errorMessage
        ? `attempt 1 fast-skipped (no resolved action): ${record.errorMessage}`
        : "attempt 1 fast-skipped (no resolved action; Stagehand returned no candidates)";
      failureReasons.push(reason);
      continue;
    }

    await page.waitForTimeout(STEP_PAUSE_MS);
    const post = await snapshotPage(page, signalCounter);
    record.post = post;

    if (resolvedAction) {
      record.resolvedMethod = resolvedAction.method ?? null;
      record.resolvedArguments = (resolvedAction.arguments ?? []).map(String);
    }

    const networkFired = post.networkCount > pre.networkCount;
    const urlChanged = post.url !== pre.url;
    const isStateClass =
      resolvedAction !== null && STATE_CLASS_METHODS.has(resolvedAction.method ?? "");
    const isClick = resolvedAction !== null && resolvedAction.method === "click";
    // State-class actions (fill/check/etc.) never move the network counter or URL,
    // so the legacy heuristic false-negatived every form fill. Re-read DOM state
    // for those; keep the navigation signal authoritative for clicks/links —
    // but ALSO route clicks through verifyDomEffect, which internally returns
    // false for non-radio/non-checkbox clicks so the network/URL signal still
    // decides those. Radios/checkboxes are click-but-no-network just like fills.
    const domVerified =
      resolvedAction !== null && (isStateClass || isClick)
        ? await verifyDomEffect(page, resolvedAction)
        : false;
    // Interior-advance transition gate (opt-in). On SPAs where a page advance
    // and a mere field-edit share one endpoint URL (Talemetry `/gq`:
    // TransitionWorklet vs EditQuestionItem — identical URLs, only the body
    // differs), a `networkFired` signal on an interior "Next" can be a
    // non-advancing POST. When the flow configures `advanceTransitionBodyPattern`
    // and THIS is a non-submit step whose ONLY positive signal is networkFired
    // (no url/dom change), require a same-window capture body to match the
    // transition pattern before trusting it. Final/submit steps keep their own
    // (stronger) submit-verification gate below; sites without the pattern are
    // unaffected.
    const isAdvanceOnlyNetwork = networkFired && !urlChanged && !domVerified;
    const advanceGateActive =
      advanceTransitionBodyPattern !== null && isAdvanceOnlyNetwork && !isFinalStep && !submitStep;
    // Advance-only-network step: the real TransitionWorklet(type="next") POST
    // often lands AFTER the STEP_PAUSE_MS snapshot (a WorkletPayload autosave
    // fires first), so poll for it — an immediate one-shot check false-negatives
    // the advance and triggers a retry that bounces the wizard back. The poll
    // short-circuits when the transition is already in-window (zero added latency
    // on the common path). Scoped by preCaptureIdx via an eviction-proof disk scan.
    const networkIsRealAdvance = !advanceGateActive
      ? networkFired
      : await waitForTransitionBody({
          page,
          preIdx: preCaptureIdx,
          advanceTransitionBodyPattern,
          timeoutMs: ADVANCE_TRANSITION_POLL_MS,
          intervalMs: ADVANCE_TRANSITION_POLL_INTERVAL_MS,
        });
    if (advanceGateActive && !networkIsRealAdvance) {
      logger.info(
        `${formatStepPrefix(stepIndex, totalSteps)} network fired but no advance-transition (type=next) body matched within ${ADVANCE_TRANSITION_POLL_MS}ms poll (non-advancing POST); not treating as verified`
      );
    }
    // DOM-only-advance veto (opt-in). A rephrase can turn an advance/"Next" step
    // into a field click (e.g. "click the Yes radio for '18?' then Next"), which
    // `verifyDomEffect` legitimately reports as dom=true — but toggling a field
    // never moves the wizard. So for a non-submit ADVANCE step (per the ORIGINAL
    // instruction) whose ONLY signal is that DOM state change, do NOT count it
    // verified: an advance requires a REAL transition (a `type=next` per
    // `networkIsRealAdvance`, or a URL change). Keyed on `networkIsRealAdvance`,
    // NOT `!networkFired` — a non-advancing autosave POST (Talemetry
    // `WorkletPayload`) fires network=true while the wizard doesn't move, and the
    // old `!networkFired` guard let a rephrase ride that autosave + a DOM reflow
    // to a FALSE advance, desyncing the flow from the wizard. Field-answer steps
    // are not advance steps, so their DOM verification is untouched; sites without
    // `advanceTransitionBodyPattern` are unaffected.
    const domVerifiedForStep = isDomOnlyAdvanceVerified({
      hasPattern: advanceTransitionBodyPattern !== null,
      isFinalOrSubmit: isFinalStep || submitStep,
      isAdvance: isAdvanceStep(step),
      domVerified,
      networkIsRealAdvance,
      urlChanged,
    })
      ? domVerified
      : false;
    if (domVerified && !domVerifiedForStep) {
      logger.info(
        `${formatStepPrefix(stepIndex, totalSteps)} advance step succeeded only via DOM state change (field toggle / non-advancing POST), not a real transition; not treating as verified`
      );
    }
    let verified = networkIsRealAdvance || urlChanged || domVerifiedForStep;

    // Final-step submit-verification gate. Replaces the deterministic
    // submitEndpointPattern regex with a Haiku 4.5 LLM judgment over
    // multi-signal evidence (network captures, page URL/title, DOM
    // submitted-state probe, site-supplied criteria). The regex
    // mislabeled successful submits as failures whenever AppCast used a
    // POST URL outside the regex's narrow expectation — empirically
    // observed in last night's sweep and validated 2026-06-11 against
    // claude-haiku-4-5-20251001 with the SUBMIT_VERDICT_SCHEMA.
    //
    // Strictness: verifySubmitWithLLM's system prompt forbids verified=true
    // unless there's at least one DOM/URL/title signal of post-submit
    // state. A 2xx network response alone is insufficient (could be
    // telemetry). The Haiku judge defaults to verified=false when
    // ambiguous — strong evidence, not lax permission.
    if (verified && requireSubmitEndpoint) {
      // Cap the scan from preMetaLength so we don't accept a historical
      // submit-shaped capture from an earlier step as proof for this one.
      const tail = recentCaptureMeta.slice(preMetaLength);

      // DOM-state probe: which submitted-state selectors (if any) match
      // the current DOM right now? Deterministic querySelector — not
      // pattern-matching. The result becomes evidence for the LLM judge.
      let domSubmittedMatch: string | null = null;
      if (submittedStateSelectors.length > 0) {
        const selectorsJson = JSON.stringify(submittedStateSelectors);
        const probeExpr = `(() => {
            const sels = ${selectorsJson};
            for (const sel of sels) {
              try {
                if (document.querySelector(sel)) return sel;
              } catch (_e) {}
            }
            return null;
          })()`;
        try {
          domSubmittedMatch = (await page.evaluate(probeExpr)) as string | null;
        } catch (err) {
          logger.warn(
            `submitted-state DOM probe threw: ${toErrorMessage(err)} — judge will reason without it`
          );
        }
      }

      // Build the unfocused-observe evidence list. Used by the judge to
      // assess whether the page transitioned to a success state.
      const unfocusedForJudge = await guardedObserve(
        stagehand,
        undefined,
        { timeout: STEP_WATCHDOG_MS },
        captureFn
      ).catch(() => [] as Action[]);

      // Quick invalid-marker count (deterministic DOM querying — counting
      // structural ng-invalid containers is not fuzzy matching, just
      // observing existence).
      const invalidMarkerCount = await countNgInvalidContainers(page).catch(() => 0);

      const pageTitle = await page.title().catch(() => "");
      const matchedSubmittedSelectors = domSubmittedMatch !== null ? [domSubmittedMatch] : [];

      const judgeVerdict = await verifySubmitWithLLM({
        client: anthropic,
        input: {
          pageUrl: post.url,
          pageTitle,
          unfocusedObserve: unfocusedForJudge.map((a) => ({
            description: a.description,
            selector: a.selector,
          })),
          networkCaptures: tail,
          invalidMarkerCount,
          ownBackendHostnames,
          successUrlFragments,
          successPageTitleHints,
          submittedStateSelectors: matchedSubmittedSelectors,
        },
        captureFn,
      });

      if (judgeVerdict === null) {
        // Bedrock-only deployment or judge call failed entirely. Fall back
        // to the DOM-state probe + requireSubmitEndpointMatch policy: if a
        // submitted-state selector matched and the site didn't require
        // network-authoritative verification, treat as verified-by-DOM.
        if (!requireSubmitEndpointMatch && domSubmittedMatch !== null) {
          logger.info(
            `submit verified via submitted-state DOM selector '${domSubmittedMatch}' (judge unavailable)`
          );
          record.verifiedBy = "submitted-state-dom";
        } else {
          verified = false;
          record.errorMessage =
            (record.errorMessage ?? "") +
            (record.errorMessage ? "; " : "") +
            "submit-judge-unavailable: no DOM-state match either";
          failureReasons.push("submit-judge-unavailable: no fallback DOM-state match");
        }
      } else if (judgeVerdict.verified) {
        logger.info(
          `submit verified by judge: ${judgeVerdict.rationale} (dom=${judgeVerdict.dom_signal ?? "—"}, url=${judgeVerdict.url_signal ?? "—"})`
        );
        record.verifiedBy = judgeVerdict.dom_signal !== null ? "submitted-state-dom" : "url";
      } else {
        verified = false;
        record.errorMessage =
          (record.errorMessage ?? "") +
          (record.errorMessage ? "; " : "") +
          `submit-judge-rejected: ${judgeVerdict.reason}`;
        failureReasons.push(`submit-judge-rejected: ${judgeVerdict.reason}`);

        // Any-4xx fallback. The judge said failed; surface any captured 4xx
        // body's field-level error JSON for the rephrase prompt downstream
        // — same role as before the migration.
        const fallbackEvidence = extractSubmitFailureEvidence(
          recentCaptures.slice(-tail.length),
          [],
          resolveReconRunDir().graphqlDir,
          "any-4xx"
        );
        if (fallbackEvidence.length > 0) {
          failureReasons.push(`any-4xx fallback: ${fallbackEvidence.split("\n")[0]}`.slice(0, 240));
        }
      }
    }

    if (verified && record.verifiedBy === null) {
      // Preserve a richer verdict set earlier in this attempt (e.g.
      // "submitted-state-dom" from the final-step DOM fallback).
      record.verifiedBy = urlChanged ? "url" : networkFired ? "network" : "dom";
    }

    // N+16 probe: Stagehand's CDP click sometimes lands on the button without
    // triggering React's SyntheticEvent layer (or jQuery delegated handlers).
    // Empirically: failing Continue clicks produce zero network, zero URL change,
    // zero DOM delta — the React handler never runs. Try invoking the element's
    // native HTMLElement.click() through the JS event pipeline as a fallback;
    // that path is guaranteed to fire registered click handlers. If it produces
    // an observable effect, treat this attempt as healed.
    // Telemetry-driven short-circuit: if a prior attempt already verified
    // via DOM state inspection (`verifiedBy === "dom"`), the checkbox/radio
    // is already in the correct state. Re-running the n+16 fallback would
    // re-dispatch click + input + change events on an already-settled
    // element, wasting STEP_PAUSE_MS + observe latency on a known-good
    // state. Skip the fallback when this evidence is already in the record.
    const priorDomVerified = attempts.some((a) => a.verifiedBy === "dom");
    if (
      !verified &&
      !priorDomVerified &&
      record.actResultSuccess === true &&
      resolvedAction?.method === "click" &&
      resolvedAction.selector
    ) {
      const xpath = xpathBody(resolvedAction.selector);
      if (xpath) {
        try {
          // Trust boundary: xpath is from Stagehand's resolved selector (not
          // URL/user input). JSON.stringify produces a safe JS string literal
          // even for content with quotes/backslashes, so composing this
          // expression cannot inject behavior through the xpath content.
          // For checkbox/radio inputs, Stagehand's isolated-world page.evaluate
          // may not trigger the browser's native default action that toggles
          // .checked. A delegated `"click .form-checkbox"` handler
          // (optionSelected-style) reads state via .is(':checked') — if the
          // default action didn't fire, it sees unchecked and treats the click as
          // "deselect this option" rather than "select it". Force the state and
          // dispatch both events (click for optionSelected, change for inputChanged)
          // so jQuery/Backbone forms record the value into their internal model.
          // Return a structured value so we can distinguish the checkbox branch's
          // "state confirmed" signal from the regular click branch. For checkbox/
          // radio, `checked` reflects `el.checked` AFTER our assignment + event
          // dispatches — that's the verification signal we trust (outerHTML
          // serialization doesn't reflect IDL .checked changes so the other
          // signals would all be blind).
          // If Stagehand resolved to a <label> that wraps a checkbox/radio
          // input (HTML labeled-control pattern — Bootstrap, MUI, Tailwind, and
          // most UI kits use it), retarget to the wrapped input. Native label
          // clicks toggle the wrapped input's .checked via the browser's
          // default action, but isolated-world page.evaluate() click()s don't
          // reliably trigger that default action — same gap N+42 documented
          // for direct checkbox/radio clicks.
          const clickExpr = `(() => { const r = document.evaluate(${JSON.stringify(xpath)}, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null); let el = r.singleNodeValue; if (!el || typeof el.click !== "function") return { fired: false }; if (el.tagName === "LABEL") { const wrapped = el.querySelector("input[type=checkbox], input[type=radio]"); if (wrapped) el = wrapped; } if (el.type === "checkbox" || el.type === "radio") { el.checked = true; el.dispatchEvent(new Event("click", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true })); return { fired: true, kind: "checkbox", checked: el.checked }; } el.click(); return { fired: true, kind: "click" }; })()`;
          const probeResult = (await page.evaluate(clickExpr)) as {
            fired: boolean;
            kind?: string;
            checked?: boolean;
          };
          const fired = probeResult.fired;
          // Vacuous-click guard for the n+16 fallback. Same rationale as
          // verifyDomEffect's click case: a checkbox/radio input's .checked
          // property can flip true via CDP click even when the input lives on
          // a hidden Angular paginator page; the FormControl bound to that
          // input doesn't re-validate, so the container's ng-invalid marker
          // persists. Reading el.checked alone declares victory; routing the
          // ancestor-invalid signal through prevents the cascade from
          // advancing past a vacuous click.
          let ancestorStillInvalid = false;
          if (probeResult.kind === "checkbox" && probeResult.checked === true) {
            const ancestorInvalidExpr = `(() => {
              const isInvalid = ${INVALID_MARKER_EL_EXPR};
              const r = document.evaluate(${JSON.stringify(xpath)}, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
              let node = r.singleNodeValue;
              if (!node) return false;
              for (let depth = 0; depth < 6 && node; depth++) {
                if (node.getAttribute && isInvalid(node)) return true;
                node = node.parentElement;
              }
              return false;
            })()`;
            ancestorStillInvalid = (await page
              .evaluate(ancestorInvalidExpr)
              .catch(() => false)) as boolean;
          }
          const checkboxStateVerified =
            probeResult.kind === "checkbox" &&
            probeResult.checked === true &&
            !ancestorStillInvalid;
          await page.waitForTimeout(STEP_PAUSE_MS);
          const retryPost = await snapshotPage(page, signalCounter);
          const retryNetworkFired = retryPost.networkCount > pre.networkCount;
          const retryUrlChanged = retryPost.url !== pre.url;
          const retryHtmlDelta = retryPost.bodyHtmlLength - pre.bodyHtmlLength;
          const retryTextChanged = retryPost.visibleTextSignature !== pre.visibleTextSignature;
          // RC2: an advance/`kind=click` "Next" that only grew the DOM
          // (validation errors rendered) with NO network/URL change is a
          // validation-blocked no-op, not a real transition — but the
          // dom-delta/text-change signals below would score it verified and
          // advance the wizard past an unfilled required page. Mirror the
          // checkbox vacuous-click guard: when a click produced no network/URL
          // change AND the page still has required-invalid controls (MUI-aware
          // via countNgInvalidContainers), treat the DOM-only signal as NOT
          // verifying so the cascade routes to the fill-invalid-fields replan.
          // Confirmed no-op signature on HCA COMPENSATION (network=false
          // url=false htmlDelta>0 textChanged) mis-scored verified=true(dom).
          const clickWasDomOnly =
            probeResult.kind === "click" && !retryNetworkFired && !retryUrlChanged;
          const clickBlockedByInvalid =
            clickWasDomOnly && (await countNgInvalidContainers(page).catch(() => 0)) > 0;
          // Advance-transition gate (same as the primary verifier, applied to the
          // n+16 fallback). RC2: for a non-submit ADVANCE/"Next" step (per the
          // ORIGINAL instruction) the fallback's positive signals — a network POST
          // that is NOT a real transition (EditQuestionItem autosave, not
          // TransitionWorklet), plus html/text deltas (validation re-renders) or a
          // checked radio (field toggle) — do NOT move the wizard. Require a REAL
          // transition: a URL change OR a same-window capture body matching
          // `advanceTransitionBodyPattern`. Without this, a non-advancing POST
          // (retryNetworkFired=true) both satisfied retryVerified AND disarmed the
          // old !retryNetworkFired-gated veto, so the fallback rode past a
          // validation-blocked Next while the page stayed put (HCA Basic Info
          // stage1d). Only arms when the site opted into the pattern; field-answer
          // (non-advance) steps keep their checkboxStateVerified/DOM path.
          // Poll for the real TransitionWorklet(type="next") like the primary
          // verifier — the transition POST can land after this snapshot, and a
          // one-shot check would false-negative and retry into a back-bounce.
          const retryNetworkIsRealAdvance =
            retryNetworkFired &&
            (await waitForTransitionBody({
              page,
              preIdx: preCaptureIdx,
              advanceTransitionBodyPattern,
              timeoutMs: ADVANCE_TRANSITION_POLL_MS,
              intervalMs: ADVANCE_TRANSITION_POLL_INTERVAL_MS,
            }));
          const fallbackDomOnlyAdvance = shouldVetoFallbackAdvance({
            hasPattern: advanceTransitionBodyPattern !== null,
            isFinalOrSubmit: isFinalStep || submitStep,
            isAdvance: isAdvanceStep(step),
            retryUrlChanged,
            retryNetworkIsRealAdvance,
          });
          if (fallbackDomOnlyAdvance) {
            logger.info(
              `${formatStepPrefix(stepIndex, totalSteps)} n+16 fallback advanced but no real transition (non-advancing POST / field toggle); not treating as verified`
            );
          }
          let retryVerified =
            !clickBlockedByInvalid &&
            !fallbackDomOnlyAdvance &&
            (retryNetworkFired ||
              retryUrlChanged ||
              retryHtmlDelta !== 0 ||
              retryTextChanged ||
              checkboxStateVerified);
          // Apply the same submit-endpoint gate the primary verifier uses.
          // Without this, the n+16 fallback would still ride past a
          // tracking-pixel-only click on the final step. Same Haiku LLM
          // judgment as the primary verifier — multi-signal corroboration
          // replaces deterministic URL regex matching.
          if (retryVerified && requireSubmitEndpoint) {
            const tail = recentCaptureMeta.slice(preMetaLength);

            // DOM-state probe (deterministic).
            let domSubmittedMatch: string | null = null;
            if (submittedStateSelectors.length > 0) {
              const selectorsJson = JSON.stringify(submittedStateSelectors);
              const probeExpr = `(() => {
                  const sels = ${selectorsJson};
                  for (const sel of sels) {
                    try {
                      if (document.querySelector(sel)) return sel;
                    } catch (_e) {}
                  }
                  return null;
                })()`;
              try {
                domSubmittedMatch = (await page.evaluate(probeExpr)) as string | null;
              } catch (err) {
                logger.warn(`n+16 submitted-state DOM probe threw: ${toErrorMessage(err)}`);
              }
            }

            const unfocusedForJudge = await guardedObserve(
              stagehand,
              undefined,
              { timeout: STEP_WATCHDOG_MS },
              captureFn
            ).catch(() => [] as Action[]);
            const invalidMarkerCount = await countNgInvalidContainers(page).catch(() => 0);
            const pageTitle = await page.title().catch(() => "");
            const matchedSubmittedSelectors = domSubmittedMatch !== null ? [domSubmittedMatch] : [];

            const judgeVerdict = await verifySubmitWithLLM({
              client: anthropic,
              input: {
                pageUrl: retryPost.url,
                pageTitle,
                unfocusedObserve: unfocusedForJudge.map((a) => ({
                  description: a.description,
                  selector: a.selector,
                })),
                networkCaptures: tail,
                invalidMarkerCount,
                ownBackendHostnames,
                successUrlFragments,
                successPageTitleHints,
                submittedStateSelectors: matchedSubmittedSelectors,
              },
              captureFn,
            });

            if (judgeVerdict === null) {
              // Bedrock-only or judge failed; fall back to DOM-state + policy.
              if (!requireSubmitEndpointMatch && domSubmittedMatch !== null) {
                logger.info(
                  `n+16 fallback submit verified via submitted-state DOM selector '${domSubmittedMatch}' (judge unavailable)`
                );
                record.verifiedBy = "submitted-state-dom";
              } else {
                retryVerified = false;
                failureReasons.push(
                  `n+16 fallback: submit-judge-unavailable: no DOM-state match either`
                );
              }
            } else if (judgeVerdict.verified) {
              logger.info(`n+16 fallback submit verified by judge: ${judgeVerdict.rationale}`);
              record.verifiedBy = judgeVerdict.dom_signal !== null ? "submitted-state-dom" : "url";
            } else {
              retryVerified = false;
              failureReasons.push(`n+16 fallback: submit-judge-rejected: ${judgeVerdict.reason}`);
            }
          }
          logger.info(
            `n+16 probe: step=${stepIndex + 1}/${totalSteps?.() ?? "?"} attempt=${attempt} el.click() fallback fired=${fired === true} kind=${probeResult.kind ?? "none"} checkboxStateVerified=${checkboxStateVerified} ancestorStillInvalid=${ancestorStillInvalid}; network=${retryNetworkFired} url=${retryUrlChanged} htmlDelta=${retryHtmlDelta} textChanged=${retryTextChanged} verified=${retryVerified}`
          );
          if (retryVerified) {
            if (record.verifiedBy === null) {
              record.verifiedBy = retryUrlChanged ? "url" : retryNetworkFired ? "network" : "dom";
            }
            record.post = retryPost;
            attempts.push(record);
            if (attempt > 1) {
              logger.info(
                `${formatStepPrefix(stepIndex, totalSteps)} healed on attempt ${attempt} via ${record.technique} + el.click() fallback`
              );
            } else {
              logger.info(
                `${formatStepPrefix(stepIndex, totalSteps)} succeeded on attempt 1 via ${record.technique} + el.click() fallback`
              );
            }
            trajectory?.push({ stepIndex, verifiedBy: record.verifiedBy });
            return "completed";
          }
        } catch (probeErr) {
          logger.warn(
            `n+16 probe: step=${stepIndex + 1}/${totalSteps?.() ?? "?"} attempt=${attempt} el.click() fallback threw: ${toErrorMessage(probeErr)}`
          );
        }
      }
    }

    attempts.push(record);

    if (verified) {
      if (attempt > 1) {
        logger.info(
          `${formatStepPrefix(stepIndex, totalSteps)} healed on attempt ${attempt} via ${record.technique} (network=${networkFired} url=${urlChanged} dom=${domVerified})`
        );
      } else {
        // Why log first-try wins explicitly: prior to this change, attempt-1
        // successes were silent — only attempts 2+ emitted "healed on attempt
        // N" lines. That under-reporting caused a 2026-06-15 telemetry-vs-log
        // contradiction where UVA Verona's run looked like a "cascade
        // collapse" (log showed 2 heals) but telemetry calls.ndjson showed
        // 32 successful Stagehand acts. Surfacing attempt-1 wins lets the
        // log match telemetry and prevents the same false alarm.
        logger.info(
          `${formatStepPrefix(stepIndex, totalSteps)} succeeded on attempt 1 via ${record.technique} (network=${networkFired} url=${urlChanged} dom=${domVerified})`
        );
      }
      trajectory?.push({ stepIndex, verifiedBy: record.verifiedBy });
      return "completed";
    }

    const effectSignals = describeAttemptEffectSignals(pre, post, recentCaptureMeta, preMetaLength);
    // Phantom-click verdict, computed from the SAME pre/post pair
    // describeAttemptEffectSignals just rendered — not recomputed deltas.
    // Recorded on every unverified attempt (not just attempt 1) so the
    // failure dump's attempts[] always carries the classification; only
    // attempt 1's verdict drives the escalation flag below.
    record.phantomClickVerdict = classifyPhantomClick({
      actResultSuccess: record.actResultSuccess,
      pre,
      post,
    });
    const reason = record.errorMessage
      ? effectSignals
        ? `${record.errorMessage}; ${effectSignals}`
        : record.errorMessage
      : effectSignals || "no observable effect (no network, url, or dom change)";
    failureReasons.push(reason);
    logger.warn(
      `${formatStepPrefix(stepIndex, totalSteps)} attempt ${attempt} (${record.technique}) produced no observable effect — ${reason}`
    );

    // One additive strategy among many: when a click on a final-step
    // submit/continue button fails AND the page surfaces a visible
    // <error> sibling next to a touched+dirty ng-invalid wrapper, surface
    // the rejection text to the LLM so it can pivot the value or return
    // outcome="impossible" instead of looping on the same plan. Silent
    // no-op on sites where the DOM pattern doesn't match — the existing
    // failure-reason and replan/cycle-detection paths still fire.
    // Empirically grounded: 22 of 22 AppCast Continue/Submit step-failure
    // dumps in a 2026-06-10 survey had the paired touched+dirty + visible
    // error text pattern with 3 distinct rejection messages.
    if (record.resolvedMethod === "click" && (isFinalStep || submitStep)) {
      const live = await extractLivePageFormEvidence(page, {
        client: anthropic,
        knownErrorClassPrefixes,
        captureFn,
      }).catch(() => ({
        invalidFieldList: "",
        errorTextList: "",
        interactiveTargetsList: "",
      }));
      const pairs = pairInvalidWithErrors(live.invalidFieldList, live.errorTextList);
      for (const p of pairs) {
        const validationReason = formatValidationRejectedReason(p);
        failureReasons.push(validationReason);
        logger.warn(`${formatStepPrefix(stepIndex, totalSteps)} ${validationReason}`);
      }
    }

    // Telemetry-driven early-exit: when attempt 1 on a final-Submit click
    // reveals new ng-invalid containers, attempts 2-N cannot succeed (the
    // form will keep blocking the POST until the new questions are answered).
    // Break out of the attempt loop so the dump runs and the step raises
    // terminal failure → replan triggers immediately, saving the cascade
    // budget that would otherwise burn on identical retries of a click the
    // page is structurally rejecting.
    if (attempt === 1) {
      // Attempt 1 of an interior advance step didn't verify (we're past the
      // `if (verified) return` above): the wizard didn't move forward. Mark it so
      // attempts 2-4 skip the proven-dead re-observe/re-click techniques and the
      // cascade goes straight to attempt-5 rephrase / replan.
      advanceUnmovedAfterAttempt1 =
        advanceTransitionBodyPattern !== null &&
        !isFinalStep &&
        !submitStep &&
        isAdvanceStep(step) &&
        !urlChanged &&
        !networkIsRealAdvance;
      // Attempt 1 phantom-clicked: Stagehand reported success but pre/post
      // shows zero observable effect. The zero-effect delta is the primary
      // signal (classifyPhantomClick above); the live AISDK elementId
      // suppression counter is corroborating evidence only — logged, never
      // gating, since a nonzero count alone is too weak a signal on a run
      // that sees dozens of suppressions across hundreds of unrelated steps.
      phantomClickAfterAttempt1 = record.phantomClickVerdict === "phantom";
      if (phantomClickAfterAttempt1) {
        const suppressedCount = getSuppressedAisdkElementIdErrorCount?.();
        logger.warn(
          `${formatStepPrefix(stepIndex, totalSteps)} phantom click detected on attempt 1 (${record.technique}): reported success with no network/url/dom change${suppressedCount !== undefined ? `; ${suppressedCount} AISDK elementId errors suppressed this session (corroborating, not causal)` : ""} — escalating attempt 2 to deep-submit-locator`
        );
      }
      const postAttemptInvalidCount = await countNgInvalidContainers(page);
      const earlyExit = isSubmitRevealedInvalid({
        // Treat the canonical submit click as "final" for this predicate
        // even when it lives mid-flow. See requireSubmitEndpoint derivation
        // above for the same gate-widening rationale.
        isFinalStep: isFinalStep || submitStep,
        requireSubmitEndpoint,
        resolvedMethod: record.resolvedMethod,
        effectSignals,
        preSubmitInvalidCount,
        postAttemptInvalidCount,
      });
      if (earlyExit) {
        const exitReason = `submit-revealed-invalid: click surfaced ${postAttemptInvalidCount - preSubmitInvalidCount} new ng-invalid container(s) (was ${preSubmitInvalidCount}, now ${postAttemptInvalidCount}); attempts 2-${MAX_STEP_ATTEMPTS} cannot heal a form that needs answers — routing to replan`;
        failureReasons.push(exitReason);
        logger.warn(`${formatStepPrefix(stepIndex, totalSteps)} ${exitReason}`);
        break;
      }

      // Telemetry-driven early-exit for interior ADVANCE steps: if the Next
      // click fired and hit the network but produced no real forward
      // transition, attempts 2-N only re-fire the autosave / bounce the wizard
      // back (the measured HCA next→back oscillation). Route to replan — which
      // can reorder a later step forward — instead of burning the cascade.
      const advanceStalled = isAdvanceStalled({
        isAdvance: isAdvanceStep(step),
        isFinalOrSubmit: isFinalStep || submitStep,
        hasPattern: advanceTransitionBodyPattern !== null,
        clickFired: record.resolvedMethod === "click" && record.actResultSuccess === true,
        networkFired,
        networkIsRealAdvance,
        urlChanged,
      });
      if (advanceStalled) {
        const exitReason = `advance-stalled: the Next click fired network but no real transition (type=next) landed within the poll window; attempts 2-${MAX_STEP_ATTEMPTS} would only re-bounce the wizard — routing to replan`;
        failureReasons.push(exitReason);
        logger.warn(`${formatStepPrefix(stepIndex, totalSteps)} ${exitReason}`);
        break;
      }
    }
  }

  const finalObserve = await guardedObserve(
    stagehand,
    step,
    { timeout: STEP_WATCHDOG_MS },
    captureFn
  ).catch(() => [] as Action[]);
  const pageTitle = await page.title().catch(() => "");
  // Discriminator data for "Stagehand sees nothing" failures: capture the raw
  // DOM and an unfocused observe so a triager can tell empty-page from
  // Stagehand-can't-see-it without reproducing the failure.
  const bodyOuterHtmlRaw = await page
    .evaluate("document.body ? document.body.outerHTML : null")
    .catch(() => null);
  const bodyOuterHtml =
    typeof bodyOuterHtmlRaw === "string" ? bodyOuterHtmlRaw.slice(0, 100_000) : null;
  const unfocusedObserve = await guardedObserve(
    stagehand,
    undefined,
    { timeout: STEP_WATCHDOG_MS },
    captureFn
  ).catch(() => [] as Action[]);
  const dumpPath =
    onStepFailure?.({
      stepIndex,
      phase,
      originalStep: step,
      attempts,
      finalObserve,
      pageUrl: page.url(),
      pageTitle,
      recentCaptures,
      bodyOuterHtml,
      unfocusedObserve,
    }) ?? null;
  if (dumpPath !== null) {
    logger.error(
      `${formatStepPrefix(stepIndex, totalSteps)} failed after ${MAX_STEP_ATTEMPTS} attempts; diagnostic bundle: ${dumpPath}`
    );
  }
  throw new StepVerificationError(
    `${formatStepPrefix(stepIndex, totalSteps)} (${step.slice(0, 60)}) failed verification after ${MAX_STEP_ATTEMPTS} attempts${dumpPath ? `; see ${dumpPath}` : ""}`,
    phantomClickAfterAttempt1 ? "phantom-click-exhausted" : "cascade-exhausted"
  );
}

/** Default resume fixture path; overridable via --resume-fixture or RESUME_FIXTURE_PATH. */

/**
 * One flow step in the shape a generated plugin hands to {@link runHealingFlow}.
 * Mirrors the recon CLI's `NormalizedStep` minus its replan-origin bookkeeping:
 * a plugin only needs the four fields the self-heal cascade reads per step.
 */
export interface HealingFlowStep {
  instruction: string;
  optional: boolean;
  upload: boolean;
  submitStep: boolean;
}

/**
 * Dependency bundle for {@link runHealingFlow}. The verifier-config fields are
 * all optional and default to the SAME values the recon CLI's `main()` passes to
 * {@link executeStepWithHealing}, so a plugin that supplies none gets identical
 * cascade behavior to a recon run with no site-specific verifier hints.
 */
export interface RunHealingFlowDeps {
  stagehand: Stagehand;
  page: Page;
  steps: HealingFlowStep[];
  logger: Logger;
  anthropic: Anthropic | null;
  resumeFixture: { buffer: Buffer; name: string; mimeType: string } | null;
  submitEndpointPattern?: string | null;
  submittedStateSelectors?: string[];
  requireSubmitEndpointMatch?: boolean;
  advanceTransitionBodyPattern?: string | null;
  successUrlFragments?: string[];
  successPageTitleHints?: string[];
  ownBackendHostnames?: string[];
  knownErrorClassPrefixes?: string[];
  wizardExitButtonLabels?: string[];
}

/** SPA-readiness gate defaults — mirror the recon CLI's post-navigation wait. */
const SPA_READINESS_TIMEOUT_MS = 15_000;
const SPA_READINESS_POLL_MS = 500;
const SPA_MIN_BODY_LENGTH = 5_000;

/**
 * Block until a just-navigated SPA has actually hydrated, so the flow does not
 * begin stepping against a shell page. `page.goto(..., "networkidle")` on a
 * Cloudflare-fronted single-page app resolves during the challenge/redirect —
 * before the client framework renders the real DOM — so the first steps would
 * otherwise probe an empty page, find no candidates, and (being optional) skip
 * the entire flow. The recon CLI has this gate inline; generated plugins call it
 * here so they inherit the same behavior. Polls `document.body.outerHTML.length`
 * up to a threshold, then proceeds regardless (best-effort, never throws).
 */
export async function waitForSpaReady(
  page: Page,
  logger: Logger,
  opts: { timeoutMs?: number; pollMs?: number; minBodyLength?: number } = {}
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? SPA_READINESS_TIMEOUT_MS;
  const pollMs = opts.pollMs ?? SPA_READINESS_POLL_MS;
  const minBodyLength = opts.minBodyLength ?? SPA_MIN_BODY_LENGTH;
  const bodyLengthExpr = "document.body ? document.body.outerHTML.length : 0";

  const readBodyLength = async (): Promise<number> => {
    const raw = await page.evaluate(bodyLengthExpr).catch(() => 0);
    return typeof raw === "number" ? raw : 0;
  };

  let bodyLength = await readBodyLength();
  if (bodyLength >= minBodyLength) {
    return;
  }

  logger.info(
    `spa readiness: body ${bodyLength} chars < ${minBodyLength} threshold — waiting for SPA to render`
  );
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await page.waitForTimeout(pollMs);
    bodyLength = await readBodyLength();
    if (bodyLength >= minBodyLength) {
      logger.info(`spa readiness: body grew to ${bodyLength} chars — SPA rendered`);
      return;
    }
  }
  logger.warn(
    `spa readiness: body still ${bodyLength} chars after ${timeoutMs}ms — proceeding with possibly incomplete page`
  );
}

/**
 * Plugin-facing wrapper that drives a recon flow's steps through the SAME
 * self-heal cascade the recon CLI uses, WITHOUT the CLI's disk-dump/replan
 * layer. Exists so a generated site plugin can reuse the battle-tested step
 * runner (its five DOM primitives + multi-signal submit verifier) as a browser
 * fallback, instead of re-implementing a bare `guardedAct` loop that has none of
 * the healing. Passing no `onStepFailure`/`captureFn`/`trajectory` means a
 * terminal step failure propagates as {@link StepVerificationError} for the
 * plugin's `execute()` to handle — there is no on-disk dump and no LLM replan.
 */
export async function runHealingFlow(deps: RunHealingFlowDeps): Promise<void> {
  const { stagehand, page, steps, logger, anthropic, resumeFixture } = deps;
  const counter = { n: 0 };
  const signalCounter = { n: 0 };
  const recentCaptures: string[] = [];
  const recentCaptureMeta: { method: string; status: number; url: string }[] = [];

  const stopCapture = wireSignalCapture(page, {
    counter,
    signalCounter,
    recentCaptures,
    recentCaptureMeta,
    getCurrentPhase: () => "flow",
    getCurrentPageOrigin: () => {
      try {
        return new URL(page.url()).origin;
      } catch {
        return "";
      }
    },
  });

  try {
    for (const [i, s] of steps.entries()) {
      await executeStepWithHealing({
        stagehand,
        page,
        step: s.instruction,
        optional: s.optional,
        upload: s.upload,
        submitStep: s.submitStep,
        stepIndex: i,
        totalSteps: () => steps.length,
        phase: "flow",
        signalCounter,
        recentCaptures,
        recentCaptureMeta,
        anthropic,
        logger,
        resumeFixture,
        isFinalStep: i === steps.length - 1,
        submitEndpointPattern: deps.submitEndpointPattern ?? null,
        submittedStateSelectors: deps.submittedStateSelectors ?? [],
        requireSubmitEndpointMatch: deps.requireSubmitEndpointMatch ?? false,
        advanceTransitionBodyPattern: deps.advanceTransitionBodyPattern ?? null,
        successUrlFragments: deps.successUrlFragments ?? [],
        successPageTitleHints: deps.successPageTitleHints ?? [],
        ownBackendHostnames: deps.ownBackendHostnames ?? [],
        knownErrorClassPrefixes: deps.knownErrorClassPrefixes ?? [],
        wizardExitButtonLabels: deps.wizardExitButtonLabels ?? [],
      });
    }
  } finally {
    stopCapture();
  }
}
