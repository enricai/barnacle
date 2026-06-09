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

import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { Action, Page, Stagehand } from "@browserbasehq/stagehand";
import { format, formatISO } from "date-fns";
import { z } from "zod/v4";

import { config } from "@/config";
import { toErrorMessage } from "@/lib/errors";
import { configureHttpDispatcher } from "@/lib/http";
import { getScriptLogger } from "@/lib/logging";
import {
  ANTHROPIC_BILLING_RX,
  captureLlmCall,
  classifyLlmCallFailure,
  type LlmCallInput,
} from "@/lib/telemetry/call-capture";
import { CALL_TYPE_RECON_REPHRASE, CALL_TYPE_RECON_REPLAN } from "@/lib/telemetry/call-types";
import { StepVerificationError } from "@/scraper/errors";
import { createBrowserSession, type ProviderName } from "@/scraper/session";
import { filterByCallType, parseSamples } from "@/scripts/judge-llm-batch";
import { CAPTURES_DIR, type Capture, STEP_FAILURES_DIR } from "@/scripts/recon-shared";
import { allocateTestmailInbox } from "@/testmail/client";
import type { Logger } from "@/types/logging";

configureHttpDispatcher();

const logger = getScriptLogger("recon-browser");

/** Navigation timeout for page.goto — raise for slow tunnels or proxied targets. */
const GOTO_TIMEOUT_MS = 120_000;
/** Post-action pause between flow steps — gives the page time to settle. */
const STEP_PAUSE_MS = 2_000;

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
interface ReplanEvent {
  replanIndex: number;
  cause: "probe-absent" | "cascade-exhausted";
  indexAtFailure: number;
  failedInstruction: string;
  replanSteps: NormalizedStep[];
  timestamp: string;
}

/** Cap on the rolling capture-filename window held in memory for failure dumps. */
const RECENT_CAPTURES_WINDOW = 20;

/**
 * Wires CDP Network event listeners onto the page's main session and returns
 * a cleanup function. Stagehand V3 already enables the Network domain
 * internally, so we only need to attach our own listeners.
 *
 * Uses `requestId` to correlate requestWillBeSent/responseReceived/loadingFinished
 * so we can fetch the response body only after it's fully received.
 */
function wireNetworkCapture(
  page: Page,
  counter: { n: number },
  signalCounter: { n: number },
  recentCaptures: string[],
  recentCaptureMeta: { method: string; status: number; url: string }[],
  getCurrentPhase: () => string,
  getCurrentPageOrigin: () => string
): () => void {
  const session = page.getSessionForFrame(page.mainFrameId());
  const inFlight = new Map<string, InFlightRequest>();

  type RequestWillBeSentEvent = {
    requestId: string;
    request: { url: string; method: string; headers: Record<string, string>; postData?: string };
  };
  type ResponseReceivedEvent = {
    requestId: string;
    response: { status: number; headers: Record<string, string> };
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

  const onFinished = async (params: LoadingFinishedEvent): Promise<void> => {
    const req = inFlight.get(params.requestId);
    if (!req) return;
    inFlight.delete(params.requestId);

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
    const opLabel = operationName ?? new URL(req.url).pathname.split("/").pop() ?? "unknown";
    const filename = `${idx}-${phase}-${opLabel}.json`;

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

    writeFileSync(join(CAPTURES_DIR, filename), JSON.stringify(capture, null, 2));

    if (capture.decodedParams !== null && capture.decodedParams !== capture.requestPostData) {
      const decodedFilename = filename.replace(/\.json$/, ".decoded.json");
      writeFileSync(
        join(CAPTURES_DIR, decodedFilename),
        JSON.stringify(capture.decodedParams, null, 2)
      );
    }

    recentCaptures.push(filename);
    if (recentCaptures.length > RECENT_CAPTURES_WINDOW) {
      recentCaptures.splice(0, recentCaptures.length - RECENT_CAPTURES_WINDOW);
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
  session.on("Network.responseReceived", onResponse);
  session.on("Network.loadingFinished", onFinished);

  return (): void => {
    session.off("Network.requestWillBeSent", onRequest);
    session.off("Network.responseReceived", onResponse);
    session.off("Network.loadingFinished", onFinished);
  };
}

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
const STEP_WATCHDOG_MS = 120_000;
/**
 * Replans triggered by the pre-step page-state probe (cheap: ~1 observe +
 * 1 LLM call). Spent when the probe sees zero candidates for a required
 * step's instruction, indicating the page state has drifted from what the
 * flow expects (e.g. previous step advanced past where the flow expected).
 */
const MAX_PROBE_REPLANS = 5;
/**
 * Replans triggered by the full self-healing cascade exhausting all 4
 * attempts (expensive: 4 attempts × backoff + LLM rephrase + observe
 * calls). Counted separately from probe replans so cheap recoveries don't
 * consume the budget reserved for expensive recoveries.
 */
const MAX_CASCADE_REPLANS = 5;
/** Guardrail on the size of an LLM-produced revised flow tail. */
const REPLAN_MAX_STEPS = 30;
/**
 * How many steps from the end of the flow are considered "trailing" for the
 * Tier 1 grace path. A verification failure on an optional step within this
 * window is treated as a benign no-op exit when a recent non-GET capture also
 * returned 2xx — the flow's real work landed and the trailing tail is
 * redundant. Two covers the common pattern: an upload step followed by a
 * final Continue/Submit click.
 */
const TRAILING_GRACE_WINDOW = 2;

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
  technique:
    | "act-string"
    | "observe-act"
    | "structured-click"
    | "observe-act-exclude"
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
}

/**
 * Trust boundary: static string literal, fixed at compile time. No interpolation
 * means no injection surface. Runs in browser context and returns a typed-narrow
 * shape via Runtime.callFunctionOn.
 */
const DOM_SNAPSHOT_EXPR = `(() => { const b = document.body; if (!b) return { html: 0, text: "" }; const t = b.innerText || ""; return { html: (b.outerHTML || "").length, text: t.length + ":" + t.slice(0, 200) }; })()`;

async function snapshotPage(page: Page, signalCounter: { n: number }): Promise<StepSnapshot> {
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
  submitEndpointPattern: RegExp | null;
}): string | null {
  const { recentCaptureMeta, preMetaLength, submitEndpointPattern } = params;
  if (!submitEndpointPattern) return null;
  const window = recentCaptureMeta.slice(preMetaLength);
  for (const m of window) {
    if (m.status < 500 || m.status >= 600) continue;
    if (!submitEndpointPattern.test(m.url)) continue;
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
    const rx = /(ng-invalid|mat-form-field-invalid|is-invalid|field-invalid|input-invalid|form-invalid)/;
    let n = 0;
    for (const el of document.querySelectorAll("[class]")) {
      const cls = el.getAttribute("class") || "";
      if (rx.test(cls)) n++;
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
    | "llm-rephrase";
  priorAttempts: readonly {
    technique: string;
    triedSelectors: readonly string[];
    errorMessage: string | null;
  }[];
}): { skip: boolean; reason: string } {
  const { technique, priorAttempts } = params;
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
export function summarizeReplanFailureKinds(params: {
  callsNdjsonPath: string;
  callType: string;
  tailCount?: number;
}): string {
  const { callsNdjsonPath, callType, tailCount = 10 } = params;
  let ndjsonContent: string;
  try {
    ndjsonContent = readFileSync(callsNdjsonPath, "utf8");
  } catch {
    return "";
  }
  const matching = filterByCallType(parseSamples(ndjsonContent), callType);
  const failures = matching.filter((s) => s.success === false).slice(-tailCount);
  if (failures.length === 0) return "";
  const counts: Record<string, number> = {};
  for (const s of failures) {
    const kind = s.failureKind ?? "unknown";
    counts[kind] = (counts[kind] ?? 0) + 1;
  }
  const parts = Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([kind, n]) => `${n}× ${kind}`);
  return `${failures.length} recent ${callType} failure(s): ${parts.join(", ")}`;
}

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
 * Lazy Anthropic client for attempt 4's rephrase. Returns null when the
 * deployment is Bedrock-only (no ANTHROPIC_API_KEY) — attempt 4 then becomes
 * a no-op and the executor escalates straight to the failure dump. The other
 * three attempts already cover the lion's share of recovery.
 */
function buildAnthropicClient(): Anthropic | null {
  if (config.scraper.useBedrock || !config.scraper.anthropicApiKey) return null;
  return new Anthropic({ apiKey: config.scraper.anthropicApiKey });
}

/**
 * Strip the `anthropic/` prefix Stagehand expects on `STAGEHAND_MODEL` so the
 * Anthropic SDK sees the bare model id (e.g. `claude-sonnet-4-6`).
 */
function anthropicModelName(): string {
  const raw = config.scraper.model;
  return raw.startsWith("anthropic/") ? raw.slice("anthropic/".length) : raw;
}

/** Injectable capture function — matches `captureLlmCall`'s signature. */
type CaptureFn = (input: LlmCallInput) => Promise<void>;

/**
 * Attempt-4 of the step-healing cascade: when three mechanical retry variations
 * all fail, this is the last resort before the step is declared terminal. Exported
 * so tests can inject a fake capture sink without touching the browser session.
 */
async function rephraseWithLLM(
  client: Anthropic,
  originalStep: string,
  triedSelectors: string[],
  observeCandidates: Action[],
  failureReasons: string[],
  captureFn: CaptureFn = captureLlmCall,
  /**
   * Optional live-page form evidence extracted by the caller (typically by
   * fetching document.body.outerHTML and running extractClassMatchedText on
   * it). When non-empty, surfaces ng-invalid form fields and visible error
   * messages so the rephrase LLM can propose corrective fills instead of
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
  }[]
): Promise<string | null> {
  const candidateList = observeCandidates
    .slice(0, 12)
    .map((a, i) => `${i + 1}. ${a.description} — ${a.selector}`)
    .join("\n");
  const unfocusedList = unfocusedObserve ? renderUnfocusedObserve(unfocusedObserve) : "";
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

  const prompt = `You are helping a browser automation agent recover from a failed step in a recon flow.

ORIGINAL INSTRUCTION:
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

Rewrite the instruction so a Stagehand act() call can resolve it unambiguously to a different element than the ones already tried. Keep it short — one sentence, natural language, no quotes around it. If the invalid-fields section above names a field AND the interactive-targets section below lists clickable options inside that same container, your rewrite SHOULD pick one of those options (e.g. for a yes/no question rendered as two radio labels, choose the candidate-favorable answer — 'No' for "do you have a non-compete", 'Yes' for "are you authorized to work", 'Prefer not to say' for demographic disclosures) rather than retrying the original click. If the unfocused observe section shows an open modal/dialog with a Save or Close action, your rewrite SHOULD invoke that action so the underlying form can clear its blocking state. If the original instruction is itself impossible on the current page (the element does not exist), reply with the literal string IMPOSSIBLE so the caller can stop trying.`;

  const model = anthropicModelName();
  const t0 = performance.now();
  try {
    const response = await client.messages.create({
      model,
      max_tokens: 200,
      messages: [{ role: "user", content: prompt }],
    });
    const latencyMs = performance.now() - t0;
    const block = response.content.find((b) => b.type === "text");
    const text = block?.type === "text" ? block.text.trim() : "";
    const parsedOk = text.length > 0 && text !== "IMPOSSIBLE";

    await captureFn({
      callId: randomUUID(),
      callType: CALL_TYPE_RECON_REPHRASE,
      model,
      systemPrompt: null,
      userContent: prompt,
      responseContent: text || null,
      parsedOk,
      inputTokens: response.usage?.input_tokens ?? null,
      outputTokens: response.usage?.output_tokens ?? null,
      latencyMs,
      success: parsedOk,
      errorMessage: parsedOk
        ? null
        : text === "IMPOSSIBLE"
          ? "model replied IMPOSSIBLE — original instruction not resolvable on current page"
          : "model returned empty text block",
      failureKind: parsedOk ? null : "response-empty",
    });

    if (!parsedOk) return null;
    return text;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logBillingErrorIfPresent(message);
    await captureFn({
      callId: randomUUID(),
      callType: CALL_TYPE_RECON_REPHRASE,
      model,
      systemPrompt: null,
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

export function logBillingErrorIfPresent(errorMessage: string): boolean {
  if (!ANTHROPIC_BILLING_RX.test(errorMessage)) return false;
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
 * Replanner response shape. Sent to Anthropic via `zodOutputFormat` so the API
 * enforces the schema and rejects malformed output (no prose preambles, no
 * markdown code fences, no schema-violating shapes). We accept either a
 * replanned step array or an explicit "impossible" outcome — the latter is
 * the structured replacement for the old IMPOSSIBLE magic string.
 */
/**
 * Flow step shape. A bare string is a required step (backward-compatible with
 * pre-N+23 flow files). An object form with `optional: true` lets the cascade
 * skip the step cleanly when Stagehand's act+observe finds no target — the
 * intended replacement for "If X is visible, do Y" conditionals that fail the
 * cascade today even when the conditional should have been skipped.
 */
const RECON_FLOW_STEP_SCHEMA = z.union([
  z.string().min(1),
  z.object({
    step: z.string().min(1),
    optional: z.boolean().default(false),
    /**
     * When true, dispatches to the site-agnostic upload primitive
     * (setInputFiles with the cached fixture) instead of the normal cascade.
     * Required because resume-upload widgets often hide the real
     * <input type="file"> behind styled buttons that Stagehand can't click.
     *
     * Explicit field per the no-regex-on-open-sets feedback — pre-N+24 code
     * pattern-matched the step text to decide dispatch, which false-positived
     * on click steps that happened to mention "resume" or "upload".
     */
    upload: z.boolean().default(false),
  }),
]);
const RECON_FLOW_SCHEMA = z.array(RECON_FLOW_STEP_SCHEMA).min(1);

/**
 * Two on-disk shapes are accepted:
 *
 *  1. Legacy bare array — every existing site flow file uses this.
 *  2. Object form — adds optional `submitEndpointPattern` regex and
 *     optional `submittedStateSelectors` array.
 *     - `submitEndpointPattern`: the final step's verifier additionally
 *       requires at least one same-origin capture in its mutation window
 *       whose URL matches the pattern. Without that match `verified=false`,
 *       even if the click produced a DOM mutation — which is the only way
 *       the self-healing cascade can detect "the click fired tracking but
 *       not the real submit XHR."
 *     - `submittedStateSelectors`: DOM-level fallback when the submit POST
 *       lands outside the per-attempt capture window. SPAs (e.g. AppCast)
 *       can swap the form for a thank-you component (`<uapp-universal-
 *       submitted-page>`) faster than the network capture pipeline records
 *       the POST. If any selector in this list matches via
 *       document.querySelector at verifier time, the submit is treated as
 *       verified-by-DOM regardless of the network capture.
 *
 * Both forms route through `parseReconFlow` into a shared internal record.
 */
const RECON_FLOW_FILE_SCHEMA = z.union([
  RECON_FLOW_SCHEMA,
  z.object({
    steps: RECON_FLOW_SCHEMA,
    submitEndpointPattern: z.string().min(1).optional(),
    submittedStateSelectors: z.array(z.string().min(1)).optional(),
  }),
]);

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

function normalizeFlow(steps: z.infer<typeof RECON_FLOW_SCHEMA>): NormalizedStep[] {
  return steps.map((s) =>
    typeof s === "string"
      ? { instruction: s, optional: false, upload: false, origin: "original" }
      : { instruction: s.step, optional: s.optional, upload: s.upload, origin: "original" }
  );
}

/**
 * Substitute `${VAR_NAME}` tokens in each step's instruction with
 * `process.env[VAR_NAME]`. Unset variables stay literal so the missing
 * allocation surfaces in Stagehand's act() instruction logs (the literal
 * `${VAR_NAME}` token appears verbatim in the rendered instruction)
 * rather than silently filling with an empty string. Only env keys
 * matching `[A-Z_][A-Z0-9_]*` are substituted — anything else is left
 * as-is, including the JS template literal syntax the flow file may
 * legitimately use elsewhere.
 */
function substituteFlowEnvVars(steps: NormalizedStep[]): NormalizedStep[] {
  const pattern = /\$\{([A-Z_][A-Z0-9_]*)\}/g;
  return steps.map((s) => ({
    ...s,
    instruction: s.instruction.replace(pattern, (match, name: string) => {
      const value = process.env[name];
      return value === undefined ? match : value;
    }),
  }));
}

/**
 * Inverse of normalizeFlow: maps an internal `NormalizedStep` back to the
 * on-disk union shape. Bare string for the common case (required,
 * non-upload); object with only the truthy flags otherwise. Round-trip is
 * lossless against `RECON_FLOW_SCHEMA` for any value the parser accepted.
 */
function denormalizeStep(
  step: NormalizedStep
): string | { step: string; optional?: true; upload?: true } {
  if (!step.optional && !step.upload) return step.instruction;
  const out: { step: string; optional?: true; upload?: true } = { step: step.instruction };
  if (step.optional) out.optional = true;
  if (step.upload) out.upload = true;
  return out;
}

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
function dedupeConsecutiveIdentical<T>(items: T[]): T[] {
  if (items.length < 2) return [...items];
  const out: T[] = [items[0]!];
  for (let i = 1; i < items.length; i++) {
    const prev = JSON.stringify(out[out.length - 1]);
    const curr = JSON.stringify(items[i]);
    if (prev !== curr) out.push(items[i]!);
  }
  return out;
}

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
function persistReplannedFlow(params: {
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
}): void {
  const {
    flowFile,
    finalPlan,
    replanEvents,
    logger,
    originalShape = "array",
    submitEndpointPattern = null,
    submittedStateSelectors = [],
  } = params;
  // Timestamp format chosen to be filesystem-safe (no colons or dots that
  // break common tooling on macOS/Windows).
  const timestamp = format(new Date(), "yyyy-MM-dd'T'HH-mm-ss");
  const backupPath = flowFile.replace(/\.json$/, `.${timestamp}.bak.json`);

  // Read ORIGINAL bytes from disk (not a re-serialization of the parsed
  // structure) so the backup is byte-identical to whatever the user had.
  let originalBytes: Buffer;
  try {
    originalBytes = readFileSync(flowFile);
  } catch (err) {
    logger.error(
      `persistReplannedFlow: failed to read original ${flowFile}: ${toErrorMessage(err)} — skipping write-back (${replanEvents.length} replan event(s) left in memory)`
    );
    return;
  }
  writeFileSync(backupPath, originalBytes);

  // Coerce replan-origin steps to optional before persistence: when a job
  // cascade-exhausts on an employer-specific field, the replan emits a
  // recovery bridge tied to that employer. Persisting it as required would
  // cascade-exhaust every subsequent run on a different employer trying to
  // fill a question that doesn't exist. Optional means the probe-absent-
  // skip path handles employers where the question isn't on the form;
  // cascade still fires for the original employer when the persisted flow
  // is replayed. Required to keep cross-employer sweeps from regressing
  // across runs.
  const denormalizedSteps = finalPlan.map((step) =>
    denormalizeStep(step.origin === "replan" && !step.optional ? { ...step, optional: true } : step)
  );
  // Cumulative-replan dedupe: each cascade-exhausted replan appends a
  // recovery bridge to the tail; after several replans the persisted flow
  // would carry stacked copies of the same bridge. Collapse them so the
  // user reviewing the diff sees only the distinct LLM-discovered steps.
  const dedupedSteps = dedupeConsecutiveIdentical(denormalizedSteps);
  // 2-space indent + trailing newline matches the existing on-disk style
  // (verified against site recon-flow.json files).
  const payload =
    originalShape === "object"
      ? {
          steps: dedupedSteps,
          ...(submitEndpointPattern !== null ? { submitEndpointPattern } : {}),
          ...(submittedStateSelectors.length > 0 ? { submittedStateSelectors } : {}),
        }
      : dedupedSteps;
  writeFileSync(flowFile, `${JSON.stringify(payload, null, 2)}\n`);
  if (dedupedSteps.length !== denormalizedSteps.length) {
    logger.info(
      `dedupe collapsed ${denormalizedSteps.length - dedupedSteps.length} consecutive identical step(s) before write-back`
    );
  }

  // Summary log block — emit each line through the Pino logger so the dev
  // transport renders it nicely and the prod JSON output stays structured.
  // Lines call out the failed instruction string verbatim + the bridge that
  // took its place so a reviewer can diff intent without opening both files.
  logger.info("── flow.json updated ──────────────────────────────────────");
  logger.info(`original backed up: ${backupPath}`);
  logger.info(`replacements (${replanEvents.length}):`);
  for (const ev of replanEvents) {
    logger.info(
      `  - replan #${ev.replanIndex} (${ev.cause}) at step ${ev.indexAtFailure + 1} @ ${ev.timestamp}`
    );
    logger.info(`      failed: ${ev.failedInstruction}`);
    logger.info(`      replaced with ${ev.replanSteps.length} step(s):`);
    for (const s of ev.replanSteps) {
      logger.info(
        `        • ${s.instruction}${s.optional ? " (optional)" : ""}${s.upload ? " (upload)" : ""}`
      );
    }
  }
  logger.info(`run \`diff ${backupPath} ${flowFile}\` to inspect.`);
  logger.info("───────────────────────────────────────────────────────────");
}

const REPLAN_RESPONSE_SCHEMA = z.discriminatedUnion("outcome", [
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
 * Pull the raw-DOM and unfocused-observe evidence out of an on-disk failure
 * dump so the replanner prompt can include ground truth, not just stagehand's
 * LLM-filtered candidate list. The dump file is a trust boundary (anything
 * could be on disk), so the body field is type-narrowed before slicing.
 */
/** Cap on per-list entries we feed back into the LLM prompt — keeps the
 * prompt token budget bounded even on pathological pages with many invalid
 * fields. Matches the existing `unfocusedList` slice for visual symmetry. */
const EVIDENCE_LIST_CAP = 12;

/** Cap on character-length of an evidence entry's text content. The point is
 * the *label* and *error signature*, not a paragraph. Anything longer is
 * almost certainly a layout container that swept up siblings. */
const EVIDENCE_ENTRY_MAX_CHARS = 200;

/**
 * Strip HTML tags and condense whitespace. Cheap-and-cheerful — we only need
 * a readable label, not faithful rendering. Decodes the handful of named
 * entities that show up in form error messages.
 */
function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/** Cap on the unfocused-observe list rendered into LLM-recovery prompts. */
const UNFOCUSED_OBSERVE_CAP = 30;

/** Pattern matching the most actionable structural UI affordances — modals,
 * dialogs, popups, overlays. Stagehand's observe describes elements in
 * natural language using these terms, and the LLM-cascade gains the most
 * leverage from seeing them surfaced because they usually indicate a
 * pending interaction (Save/Close/Confirm) the cascade must complete
 * before the form's enclosing validity clears. */
const MODAL_PRIORITY_RX = /(modal|dialog|popup|overlay|drawer)/i;

/**
 * Render an unfocused-observe array into a numbered string the prompt can
 * consume, prioritizing any modal/dialog/overlay/popup entries to the top
 * regardless of their index in the raw list. Without this prefix, modals
 * that Stagehand observes at index 70+ (verified against the prior run's
 * dump — 11 modal entries lived at positions 64-79 of 80) get truncated
 * away by the cap and the LLM-replan can't propose to save/close them.
 */
function renderUnfocusedObserve(
  observations: Action[],
  cap: number = UNFOCUSED_OBSERVE_CAP
): string {
  const modalHits: Action[] = [];
  const others: Action[] = [];
  for (const a of observations) {
    const desc = a.description || "";
    if (MODAL_PRIORITY_RX.test(desc)) {
      modalHits.push(a);
    } else {
      others.push(a);
    }
  }
  const combined = [...modalHits, ...others].slice(0, cap);
  return combined.map((a, i) => `${i + 1}. ${a.description} — ${a.selector}`).join("\n");
}

/**
 * Scan the page body HTML for opening tags whose class attribute matches a
 * marker pattern. Returns a short text snippet from each match's
 * immediately-following content (capped at EVIDENCE_ENTRY_MAX_CHARS) tagged
 * with the relevant class signature.
 *
 * Pure string scan; no DOM parser. Intentionally only checks the class on
 * each *opening tag* (not "this element's full subtree class signature") so
 * nested invalid descendants don't get attributed to an outer valid parent
 * via greedy matching of an outer-tag close. False positives are acceptable
 * in an advisory evidence section — extra noise is strictly better than the
 * current zero signal.
 */
function extractClassMatchedText(html: string, classPattern: RegExp, cap: number): string[] {
  // Match each opening tag with a class attribute. No closing-tag anchor —
  // we just look at content following the tag, up to a bounded window.
  const tagPattern = /<([a-zA-Z][a-zA-Z0-9-]*)\b[^>]*?\bclass=("[^"]*"|'[^']*')[^>]*?>/g;
  const entries: string[] = [];
  let m: RegExpExecArray | null;
  m = tagPattern.exec(html);
  while (m !== null) {
    const classValue = m[2]!.slice(1, -1);
    if (classPattern.test(classValue)) {
      // Look at up to 600 chars of HTML following this opening tag — enough
      // to capture the label / first error-message text but bounded so a
      // single match doesn't sweep up half the page.
      const followingWindow = html.slice(m.index + m[0].length, m.index + m[0].length + 600);
      const text = stripHtml(followingWindow).slice(0, EVIDENCE_ENTRY_MAX_CHARS);
      if (text.length > 0) {
        // Tag a short class fingerprint so the LLM can correlate signature
        // patterns (e.g. "ng-invalid + ng-touched" = user-interacted invalid).
        const classFingerprint = classValue
          .split(/\s+/)
          .filter((c) => classPattern.test(c) || /(invalid|error|required)/i.test(c))
          .slice(0, 4)
          .join(" ");
        entries.push(`${text}${classFingerprint ? `  [${classFingerprint}]` : ""}`);
        if (entries.length >= cap) break;
      }
    }
    m = tagPattern.exec(html);
  }
  return entries;
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
async function extractLivePageFormEvidence(page: Page): Promise<{
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
  const invalidPattern =
    /(ng-invalid|mat-form-field-invalid|is-invalid|field-invalid|input-invalid|form-invalid)/;
  const errorPattern =
    /(error-message|mat-error|field-error|validation-error|required-message|invalid-feedback|form-error|help-block-error)/;
  const invalidEntries = extractClassMatchedText(body, invalidPattern, EVIDENCE_LIST_CAP);
  const errorEntries = extractClassMatchedText(body, errorPattern, EVIDENCE_LIST_CAP);
  const interactiveTargets = await extractInteractiveTargetsNearInvalid(page).catch(
    () => [] as string[]
  );
  return {
    invalidFieldList: invalidEntries.map((e, i) => `${i + 1}. ${e}`).join("\n"),
    errorTextList: errorEntries.map((e, i) => `${i + 1}. ${e}`).join("\n"),
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
 * already saves every captured request to `CAPTURES_DIR` with its parsed
 * `responseBody`; this helper reads those files back, filters to captures
 * matching the configured submit pattern with status >= 400, and walks
 * common error-shape conventions (`{ errors: [{ field, message }] }`,
 * `{ validation/fieldErrors: { … } }`, `{ message }`).
 *
 * Returns a short bullet list ready to drop into a prompt; empty string
 * when no failed submit was found. Advisory — never load-bearing.
 */
export function extractSubmitFailureEvidence(
  recentCaptureFilenames: readonly string[],
  submitEndpointPattern: RegExp | null,
  capturesDir: string = CAPTURES_DIR,
  mode: "strict" | "any-4xx" = "strict"
): string {
  if (recentCaptureFilenames.length === 0) return "";
  if (mode === "strict" && !submitEndpointPattern) return "";
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
      if (mode === "strict" && !submitEndpointPattern!.test(capture.url)) continue;
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
              : `(status ${status}; no structured error body)`;
        records.push(`${status} ${capture.url}: ${fallback}`);
        continue;
      }
      for (const e of errors.slice(0, 8)) {
        records.push(`${status} ${capture.url} — ${e}`);
      }
    } catch {
      // capture file missing or malformed — skip
    }
  }
  return records.map((r, i) => `${i + 1}. ${r}`).join("\n");
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

function readFailureDumpEvidence(failureDumpPath: string): {
  bodyExcerpt: string;
  unfocusedList: string;
  invalidFieldList: string;
  errorTextList: string;
  recentFailureReasons: string[];
} {
  try {
    const dump = JSON.parse(readFileSync(failureDumpPath, "utf8")) as {
      bodyOuterHtml?: string | null;
      unfocusedObserve?: Action[];
      attempts?: { errorMessage?: string | null }[];
    };
    const rawBody = dump.bodyOuterHtml;
    const bodyExcerpt = typeof rawBody === "string" ? rawBody.slice(0, 8000) : "";
    const unfocusedList = renderUnfocusedObserve(dump.unfocusedObserve ?? []);

    const fullBody = typeof rawBody === "string" ? rawBody : "";
    // Framework-agnostic invalid-state markers. Covers Angular (`ng-invalid`,
    // `mat-form-field-invalid`), Bootstrap (`is-invalid`), and the generic
    // `*-invalid` / `field-invalid` patterns most form libraries adopt.
    const invalidPattern =
      /(ng-invalid|mat-form-field-invalid|is-invalid|field-invalid|input-invalid|form-invalid)/;
    const invalidEntries = extractClassMatchedText(fullBody, invalidPattern, EVIDENCE_LIST_CAP);
    const invalidFieldList = invalidEntries.map((e, i) => `${i + 1}. ${e}`).join("\n");

    // Visible error/required-message containers. The class-pattern union
    // catches the common naming conventions across Material, Bootstrap,
    // custom Angular forms, and React form libraries.
    const errorPattern =
      /(error-message|mat-error|field-error|validation-error|required-message|invalid-feedback|form-error|help-block-error)/;
    const errorEntries = extractClassMatchedText(fullBody, errorPattern, EVIDENCE_LIST_CAP);
    const errorTextList = errorEntries.map((e, i) => `${i + 1}. ${e}`).join("\n");

    // Trailing slice of attempt error messages. The dump's per-attempt
    // errorMessage carries the verifier's structured reason (e.g.
    // `submit-endpoint-not-matched: pattern …`), which currently only the
    // rephrase prompt sees. Surfacing them here gives the replan LLM the
    // same context.
    const recentFailureReasons = (dump.attempts ?? [])
      .map((a) => (typeof a.errorMessage === "string" ? a.errorMessage.trim() : ""))
      .filter((r): r is string => r.length > 0)
      .slice(-5);

    return { bodyExcerpt, unfocusedList, invalidFieldList, errorTextList, recentFailureReasons };
  } catch {
    // Swallowed by design: a missing dump must not fail the replan.
    return {
      bodyExcerpt: "",
      unfocusedList: "",
      invalidFieldList: "",
      errorTextList: "",
      recentFailureReasons: [],
    };
  }
}

/**
 * Global fallback after a step terminally fails all healing attempts: rewrites
 * only the un-run tail of the flow so already-verified steps are not disturbed.
 * Exported so tests can inject a fake capture sink without a live browser.
 */
async function replanRemainingFlow(params: {
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
  /** Compiled submit-endpoint regex from the flow file, when defined. */
  submitEndpointPattern?: RegExp | null;
  /**
   * Optional short tail of prior steps' verification signals (network,
   * url, dom, submitted-state-dom). When provided, the prompt gets a
   * PRIOR STEP TRAJECTORY section so the LLM can distinguish "page has
   * been visibly transitioning (URL changes / submitted-state markers)"
   * from "page has been static (network signals + DOM-only updates)".
   * Helps the replanner avoid proposing regression steps when the form
   * has already advanced.
   */
  trajectory?: readonly { stepIndex: number; verifiedBy: AttemptRecord["verifiedBy"] }[];
}): Promise<NormalizedStep[] | null> {
  const {
    client,
    originalFlow,
    completedSteps,
    failedStep,
    remainingSteps,
    failureDumpPath,
    page,
    stagehand,
    captureFn = captureLlmCall,
    recentCaptures = [],
    submitEndpointPattern = null,
    trajectory = [],
  } = params;
  const trajectoryList =
    trajectory.length > 0
      ? trajectory
          .slice(-5)
          .map(
            (t) => `step ${t.stepIndex + 1} verified via ${t.verifiedBy ?? "(no signal recorded)"}`
          )
          .join("; ")
      : "";
  const candidates = await stagehand
    .observe({ timeout: STEP_WATCHDOG_MS })
    .catch(() => [] as Action[]);
  const candidateList = renderUnfocusedObserve(candidates);
  const pageTitle = await page.title().catch(() => "");

  // Without raw DOM in the prompt, the LLM only sees stagehand.observe()'s
  // filtered candidate list and hallucinates about surrounding state
  // (auth-wall reset, closed-message interstitial, etc.).
  const { bodyExcerpt, unfocusedList, invalidFieldList, errorTextList, recentFailureReasons } =
    readFailureDumpEvidence(failureDumpPath);
  const failureReasonList = recentFailureReasons.map((r, i) => `${i + 1}. ${r}`).join("\n");
  const submitFailureList = extractSubmitFailureEvidence(recentCaptures, submitEndpointPattern);

  const prompt = `You are helping a browser automation agent recover from a failed flow step.

THE ORIGINAL FLOW (as the user wrote it):
${originalFlow.map((s, i) => `${i + 1}. ${s}`).join("\n")}

STEPS ALREADY SUCCESSFULLY COMPLETED (do not re-run these):
${completedSteps.length > 0 ? completedSteps.map((s, i) => `${i + 1}. ${s}`).join("\n") : "(none)"}

THE STEP THAT JUST FAILED (after exhausting its per-step healing cascade):
${failedStep}

REMAINING UNEXECUTED STEPS (after the failed one):
${remainingSteps.length > 0 ? remainingSteps.map((s, i) => `${i + 1}. ${s}`).join("\n") : "(none)"}

CURRENT BROWSER STATE:
URL: ${page.url()}
Title: ${pageTitle}

WHY VERIFICATION FAILED (latest attempt reasons from the cascade — read these carefully, they explain WHY the step is being declared failed):
${failureReasonList || "(none)"}

FORM FIELDS CURRENTLY MARKED INVALID (text + class signature for any element whose class matches the framework-agnostic invalid pattern — ng-invalid, mat-form-field-invalid, is-invalid, etc.):
${invalidFieldList || "(none)"}

VISIBLE ERROR / REQUIRED-FIELD MESSAGES ON THE PAGE (extracted text from error-class containers — error-message, mat-error, field-error, validation-error, invalid-feedback, etc.):
${errorTextList || "(none)"}

STRUCTURED SERVER-SIDE VALIDATION ERRORS (parsed from captured 4xx responses to the submit endpoint — when populated, the form's submit DID fire and the server rejected it with specific feedback):
${submitFailureList || "(none)"}

PRIOR STEP TRAJECTORY (how the last few completed steps verified — url / submitted-state-dom signal pages that visibly transitioned; network / dom signal pages that stayed static. Use this to distinguish "page has been advancing through the flow" from "page has been static and the form is still in front of us"; avoid proposing regression-style steps if the trajectory shows recent transitions):
${trajectoryList || "(none)"}

ELEMENTS CURRENTLY VISIBLE ON THE PAGE (stagehand.observe with the failed instruction):
${candidateList || "(no candidates returned by observe)"}

UNFOCUSED OBSERVE (what Stagehand sees on the page without any instruction filter):
${unfocusedList || "(none)"}

PAGE BODY HTML AT FAILURE (truncated to 8KB — use this to detect interstitials, error messages, auth walls, or unexpected page states that the observe lists miss):
${bodyExcerpt || "(missing)"}

DIAGNOSTIC DUMP FILE (for reference):
${failureDumpPath}

Emit ONLY the RECOVERY BRIDGE steps from the failure point back to where the
original flow's remaining tail can resume. The driver will automatically append
the original REMAINING UNEXECUTED STEPS (shown above) AFTER your bridge steps,
so you do NOT need to re-emit them. Your job is just the recovery — the few
steps needed to get the SPA from its current state into a shape where the
original tail can run.

Concretely:
- If the page is at an intermediate state the original flow didn't anticipate,
  emit the steps that bridge to where the original flow can pick back up.
- If the failed step's effect actually happened despite our verifier saying it
  didn't (e.g. SPA-internal navigation that produced no observable signal),
  the bridge may be EMPTY — just re-emit the failed step (or nothing if the
  state already advanced) and the original tail picks up after.
- Do NOT try to drive the form to completion yourself — the original tail
  covers that. Just unstick the cascade and let it resume.

CRITICAL: single-action steps only.
Each step in your output array MUST invoke exactly ONE DOM action:
- one \`fill\` on one input, OR
- one \`click\` on one button/radio/checkbox, OR
- one \`selectOption\` on one dropdown, OR
- one observable trigger like "upload the resume PDF".

The underlying agent (Stagehand \`act()\`) can only execute one action per step.
Multi-action steps silently drop all but one action and corrupt downstream form state.

WRONG (multi-action — DO NOT emit steps like these):
  "Fill in First Name 'Reginald', Last Name 'Reconaldo', Email '...'"
  "If Street is visible fill Street; if City is visible fill City; then click Continue"
  "Fill the signature field with 'Name'; check the I agree box; click Submit"

RIGHT (single-action — emit steps like these):
  "Fill in the First Name field with 'Reginald'"
  "Fill in the Last Name field with 'Reconaldo'"
  "Fill in the Email field with '...'"
  "If a Street Address field is visible, fill it with '123 Test Lane'"
  "If a City field is visible, fill it with 'Austin'"
  "Click the Continue button"
  "Fill the signature field with 'Name'"
  "Check the I agree checkbox"
  "Click the Submit button"

A step CAN combine ONE conditional + ONE action ("If X is visible, do Y") — that
counts as single-action because the conditional only gates whether the action
runs. But NEVER combine multiple actions even when they're each conditional.

Constraints:
- Do NOT include the already-completed steps in your output.
- Do NOT include the original REMAINING UNEXECUTED STEPS in your output — they will be appended automatically after your bridge.
- Emit ONLY the recovery bridge steps that get the SPA from its current state to where the original tail can resume.
- If you can recover the flow, return outcome="replan" with the steps array (can be just 1-2 steps if that's all that's needed).
- If the user's intent is unreachable from this page state, return outcome="impossible" with a brief reason.
- Maximum ${REPLAN_MAX_STEPS} bridge steps.
- Each step is a single DOM action (see CRITICAL section above).

OPTIONAL STEPS:
Each step entry can be a bare string (required step — cascade fails if the
target is missing) OR an object \`{step: "...", optional: true}\` (cascade
skips cleanly if Stagehand observes no candidates).

Use optional ONLY when the action is genuinely conditional on the page having
a specific element. Examples:
  - "If a 'Currently employed here' checkbox is visible, check it" → emit as
    \`{step: "Check the 'Currently employed here' checkbox", optional: true}\`
  - "If an 'Add Experience' button is visible, click it" → emit as
    \`{step: "Click the 'Add Experience' button", optional: true}\`

Do NOT mark required actions optional (form fills the user needs filled, the
Continue/Submit button at the end of a section, etc.) — that would silently
skip them when the cascade can't see them, leaving the form half-filled.

UPLOAD STEPS:
A step that uploads a file to a file input MUST be emitted as
\`{step: "...", upload: true}\` so the cascade routes it to the file-upload
primitive (which handles widgets that hide the real <input type=file> behind
a styled button Stagehand can't click).

Do NOT mark non-upload actions as upload — even if their description mentions
"upload" or "resume". Examples:
  - "Upload the test resume PDF when the upload screen appears" → emit as
    \`{step: "Upload the test resume PDF", upload: true}\`
  - "Click Continue past the resume upload screen" → emit as the bare string
    "Click Continue past the resume upload screen" (NOT upload — it's a click).
  - "Click the Remove button to delete the previous resume" → bare string
    (NOT upload — it's a click).

A step CAN be both upload and optional (object form with both fields set),
but that's rare — most upload steps are required.`;

  const model = anthropicModelName();
  const t0 = performance.now();
  try {
    const response = await client.messages.parse({
      model,
      max_tokens: 2000,
      messages: [{ role: "user", content: prompt }],
      output_config: {
        format: zodOutputFormat(REPLAN_RESPONSE_SCHEMA),
      },
    });
    const latencyMs = performance.now() - t0;
    // Structured output: SDK throws on JSON or schema-validation failure, so
    // reaching this point means parsed_output is the validated object. The
    // typings keep T | null in the signature for the "no format supplied"
    // branch — guard so the discriminated-union narrows cleanly below.
    const parsed = response.parsed_output;
    if (parsed === null) {
      throw new Error("structured-output enabled but parsed_output is null");
    }
    const textBlock = response.content.find((b) => b.type === "text");
    const rawText = textBlock?.type === "text" ? textBlock.text : "";

    await captureFn({
      callId: randomUUID(),
      callType: CALL_TYPE_RECON_REPLAN,
      model,
      systemPrompt: null,
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

    if (parsed.outcome === "replan") return normalizeFlow(parsed.steps);
    return null;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logBillingErrorIfPresent(message);
    await captureFn({
      callId: randomUUID(),
      callType: CALL_TYPE_RECON_REPLAN,
      model,
      systemPrompt: null,
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

function dumpReplanRecord(params: {
  stepIndex: number;
  phase: string;
  replanIndex: number;
  completedSteps: string[];
  originalRemaining: string[];
  newRemaining: string[];
}): string {
  mkdirSync(STEP_FAILURES_DIR, { recursive: true });
  const idx = String(params.stepIndex).padStart(3, "0");
  const filename = `${idx}-${params.phase}.replan.json`;
  const target = join(STEP_FAILURES_DIR, filename);
  writeFileSync(
    target,
    JSON.stringify(
      {
        timestamp: new Date().toISOString(),
        stepIndex: params.stepIndex,
        phase: params.phase,
        replanIndex: params.replanIndex,
        completedSteps: params.completedSteps,
        originalRemaining: params.originalRemaining,
        newRemaining: params.newRemaining,
      },
      null,
      2
    )
  );
  return target;
}

function dumpStepFailure(params: {
  stepIndex: number;
  phase: string;
  originalStep: string;
  attempts: AttemptRecord[];
  finalObserve: Action[];
  pageUrl: string;
  pageTitle: string;
  recentCaptures: string[];
  /**
   * Ground-truth DOM at failure time, truncated to 100 KB. `finalObserve` is
   * filtered through Stagehand's LLM-aware observer; this is the raw body so a
   * triager can tell "the page is empty / interstitial" from "the page has
   * content but Stagehand can't see it." Null when the page evaluate fails.
   */
  bodyOuterHtml: string | null;
  /**
   * `stagehand.observe()` with no instruction — what Stagehand sees on the
   * page unprompted. Complements `finalObserve` (which is observe-with-step).
   */
  unfocusedObserve: Action[];
}): string {
  mkdirSync(STEP_FAILURES_DIR, { recursive: true });
  const idx = String(params.stepIndex).padStart(3, "0");
  const filename = `${idx}-${params.phase}.json`;
  const bundle = {
    timestamp: new Date().toISOString(),
    stepIndex: params.stepIndex,
    phase: params.phase,
    originalStep: params.originalStep,
    pageUrl: params.pageUrl,
    pageTitle: params.pageTitle,
    attempts: params.attempts,
    finalObserve: params.finalObserve,
    unfocusedObserve: params.unfocusedObserve,
    bodyOuterHtml: params.bodyOuterHtml,
    recentCaptures: params.recentCaptures.slice(-5),
  };
  const target = join(STEP_FAILURES_DIR, filename);
  writeFileSync(target, JSON.stringify(bundle, null, 2));
  return target;
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
}): Promise<boolean> {
  const { page, isUploadStep, fixture, logger, signalCounter } = params;
  if (!isUploadStep) {
    return false;
  }
  if (!fixture) {
    return false;
  }
  // Raw-DOM xpath: matches `<input type="file">` even when accessibility-tree
  // observers miss it (the common pattern when sites style the input invisible
  // and overlay a button on top of it).
  const fileInputSelector = "xpath=//input[@type='file']";
  let count = 0;
  try {
    count = await page.locator(fileInputSelector).count();
  } catch (err) {
    logger.warn(`upload primitive: file-input probe threw: ${toErrorMessage(err)}`);
    return false;
  }
  if (count === 0) {
    logger.info("upload primitive: no <input type=file> on page; falling through to cascade");
    return false;
  }
  const target = page.locator(fileInputSelector).first();
  const networkCountBefore = signalCounter.n;
  try {
    await target.setInputFiles({
      name: fixture.name,
      mimeType: fixture.mimeType,
      buffer: fixture.buffer,
    });
  } catch (err) {
    logger.warn(`upload primitive: setInputFiles threw: ${toErrorMessage(err)}`);
    return false;
  }
  // Primary signal: wait for a non-poll POST to fire. Widgets that upload
  // immediately on setInputFiles (the common case — ClearCompany, AppCast,
  // most ATS file widgets) trigger one within milliseconds. signalCounter
  // already excludes background polls, so a single bump here is the upload.
  const startedAt = performance.now();
  while (performance.now() - startedAt < UPLOAD_NETWORK_TIMEOUT_MS) {
    if (signalCounter.n > networkCountBefore) {
      logger.info(
        `upload primitive: network activity detected post-setInputFiles (name=${fixture.name}, size=${fixture.buffer.length}b)`
      );
      return true;
    }
    await page.waitForTimeout(UPLOAD_NETWORK_POLL_INTERVAL_MS);
  }
  // Fallback: some widgets defer the upload to a separate Save click. For
  // those the DOM still has the attached File — verify there. Widgets that
  // clear input.files on upload trigger (ClearCompany's jQuery File Upload)
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
    logger.warn("upload primitive: no network activity within timeout and no file attached in DOM");
    return false;
  }
  logger.info(
    `upload primitive: file attached in DOM after setInputFiles (deferred-upload widget; name=${fixture.name}, filesLength=${attachedLength})`
  );
  return true;
}

/**
 * Dispatch DOM `input` + `change` + `blur` events on the given element from the
 * page context. Stagehand's `fill` for regular text inputs types via CDP
 * `Input.insertText` which fires `input` per keystroke but never fires `change`
 * — `change` only fires on blur, and Stagehand never blurs. Many jQuery /
 * Backbone forms (e.g. ClearCompany's formField.js) bind their input handlers
 * to the native `change` event via event delegation; without `change` firing,
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
          // Backbone forms (e.g. ClearCompany formField.js's "change
          // .field-dropdown,.form-input" delegated handler) record the value
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
          const r = document.evaluate(${JSON.stringify(xpath)}, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
          let node = r.singleNodeValue;
          if (!node) return false;
          const rx = /(ng-invalid|mat-form-field-invalid|is-invalid|field-invalid|input-invalid)/;
          for (let depth = 0; depth < 6 && node; depth++) {
            const cls = node.getAttribute && node.getAttribute("class");
            if (cls && rx.test(cls)) return true;
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
  const INVALID_CLASS_RX = /(ng-invalid|mat-form-field-invalid|is-invalid|field-invalid|input-invalid)/;
  const MARKERS = ["ng-invalid", "mat-form-field-invalid", "is-invalid", "field-invalid", "input-invalid", "ng-touched", "ng-dirty"];
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
    const wrapperOnlyInvalid =
      !leafInvalid &&
      el !== ctrl &&
      (ctrl.value === "" || ctrl.value == null || selectPlaceholderOpen) &&
      /(ng-pristine|ng-untouched)/.test(ctrlClass);
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
function narrowInvalidFormControl(entry: unknown): InvalidFormControl | null {
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

async function probeFormValidityBeforeSubmit(params: {
  page: Page;
  stepIndex: number;
  logger: Logger;
}): Promise<InvalidFormControl[]> {
  const { page, stepIndex, logger } = params;
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
        `step ${stepIndex + 1} pre-submit probe: ${out.length} ng-invalid form control(s) detected; empty=${out.filter((e) => e.emptyOrUnchecked).length}; auto-picked=${autoCount}`
      );
    } else {
      logger.info(`step ${stepIndex + 1} pre-submit probe: no ng-invalid form controls detected`);
    }
    return out;
  } catch (err) {
    logger.warn(
      `step ${stepIndex + 1} pre-submit probe threw: ${toErrorMessage(err)} — proceeding without pre-flight evidence`
    );
    return [];
  }
}

async function probeStepBeforeAttempts(params: {
  stagehand: Stagehand;
  step: string;
  stepIndex: number;
  logger: Logger;
}): Promise<"present" | "absent"> {
  const { stagehand, step, stepIndex, logger } = params;
  try {
    const candidates = await stagehand.observe(step, { timeout: STEP_WATCHDOG_MS });
    if (candidates.length === 0) {
      logger.info(
        `step ${stepIndex + 1}: probe found 0 candidates — treating as absent (skip cascade, route to replan if required)`
      );
      return "absent";
    }
    logger.info(`step ${stepIndex + 1}: probe found ${candidates.length} candidate(s)`);
    return "present";
  } catch (err) {
    // Bias toward the existing behavior on errors: don't trigger a spurious
    // replan when the probe itself is the broken thing.
    logger.warn(
      `step ${stepIndex + 1}: probe threw ${toErrorMessage(err)} — treating as present (cascade will run)`
    );
    return "present";
  }
}

async function executeStepWithHealing(params: {
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
  stepIndex: number;
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
   * Optional accumulator the cascade pushes onto when this step verifies.
   * Lets the main loop maintain a short cross-step trajectory of `verifiedBy`
   * signals (network / url / dom / submitted-state-dom) which is then
   * surfaced to the replan prompt as "PRIOR STEP TRAJECTORY" so the LLM
   * can tell whether the page has been visibly transitioning vs. staying
   * static. When omitted, the cascade behaves identically — purely
   * additive instrumentation.
   */
  trajectory?: { stepIndex: number; verifiedBy: AttemptRecord["verifiedBy"] }[];
}): Promise<void> {
  const {
    stagehand,
    page,
    step,
    optional,
    upload,
    stepIndex,
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
    trajectory,
  } = params;
  const requireSubmitEndpoint = isFinalStep && submitEndpointPattern !== null;
  const compiledSubmitPattern = requireSubmitEndpoint ? new RegExp(submitEndpointPattern!) : null;
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
    })
  ) {
    logger.info(`step ${stepIndex + 1} resolved by upload primitive`);
    trajectory?.push({ stepIndex, verifiedBy: "network" });
    return;
  }

  // Snapshot the capture-meta tail length at step entry. The probe-absent
  // legitimate-transition check (below) scans captures landed during THIS
  // step's processing — earlier-step transitions don't count.
  const stepStartMetaLength = recentCaptureMeta.length;

  // Page-state probe BEFORE the cascade. When the page doesn't have any
  // candidate matching the step's instruction we either skip cleanly
  // (optional) or escalate straight to replan (required) — far cheaper than
  // burning 4 attempts on a page that clearly isn't the right one.
  const probeResult = await probeStepBeforeAttempts({ stagehand, step, stepIndex, logger });
  if (probeResult === "absent") {
    if (optional) {
      logger.info(`step ${stepIndex + 1} skipped (optional, probe found no candidates)`);
      return;
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
        `step ${stepIndex + 1} skipped (probe absent but recent transition detected: ${transitionUrl})`
      );
      trajectory?.push({ stepIndex, verifiedBy: "url" });
      return;
    }
    // Telemetry-driven backend-error detection. If the same-window capture
    // meta contains a 5xx response from the configured submit endpoint,
    // the backend errored — no rephrase or replan can heal a server crash.
    // Fail-fast so the runner surfaces the diagnostic instead of burning
    // budget on retries that will fail identically.
    const backendErrorUrl = findRecentBackendError({
      recentCaptureMeta,
      preMetaLength: stepStartMetaLength,
      submitEndpointPattern: submitEndpointPattern ? new RegExp(submitEndpointPattern) : null,
    });
    if (backendErrorUrl !== null) {
      logger.error(
        `step ${stepIndex + 1} backend error detected (submit endpoint returned 5xx: ${backendErrorUrl}); aborting cascade`
      );
      throw new StepVerificationError(
        `step ${stepIndex + 1} (${step.slice(0, 60)}) backend 5xx at ${backendErrorUrl} — unrecoverable`,
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
    const unfocusedObserve = await stagehand
      .observe({ timeout: STEP_WATCHDOG_MS })
      .catch(() => [] as Action[]);
    const dumpPath = dumpStepFailure({
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
    });
    throw new StepVerificationError(
      `step ${stepIndex + 1} (${step.slice(0, 60)}) probe found no candidates on page; see ${dumpPath}`,
      "probe-absent"
    );
  }

  // Pre-submit form-validity probe. Only fires on the final flow step when
  // the flow declared a submitEndpointPattern (the gate signal for "this
  // is the submission step"). Finds form controls still marked ng-invalid
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

  for (let attempt = 1; attempt <= MAX_STEP_ATTEMPTS; attempt++) {
    // Telemetry-driven technique-skip: when a cascade technique's
    // preconditions cannot be met by the prior attempts' state, running
    // it would burn the attempt slot without exercising new behaviour.
    // Skip to the next iteration so the cascade reaches its higher-value
    // techniques faster.
    if (attempt > 1) {
      const wouldBeTechnique: AttemptRecord["technique"] =
        attempt === 2
          ? "observe-act"
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
      });
      if (decision.skip) {
        logger.info(
          `step ${stepIndex + 1} attempt ${attempt} (${wouldBeTechnique}) skipped: ${decision.reason}`
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
    };

    // First resolved action from Stagehand's `act` result — used to decide
    // whether this attempt's signal should come from the network/URL pair or
    // from DOM re-read. Captured here so both branches of the cascade write to it.
    let resolvedAction: Action | null = null;

    try {
      if (attempt === 1) {
        record.technique = "act-string";
        record.instruction = step;
        const result = await stagehand.act(step, { timeout: STEP_WATCHDOG_MS });
        record.actResultSuccess = result.success;
        record.actResultDescription = result.actionDescription;
        for (const action of result.actions ?? []) {
          if (action.selector) triedSelectors.push(action.selector);
          if (!resolvedAction) resolvedAction = action;
        }
      } else if (attempt === 2 || attempt === 4) {
        record.technique = attempt === 2 ? "observe-act" : "observe-act-exclude";
        const observeOptions =
          attempt === 4 && triedSelectors.length > 0
            ? { ignoreSelectors: [...triedSelectors], timeout: STEP_WATCHDOG_MS }
            : { timeout: STEP_WATCHDOG_MS };
        const candidates = await stagehand.observe(step, observeOptions);
        if (candidates.length === 0) {
          record.errorMessage = "observe returned no candidates";
          // Optional-step short-circuit: when attempt 2 confirms no candidates
          // match AND the step was marked optional in the flow, skip cleanly.
          // We require attempt 1 to also have returned no actions (no resolved
          // selector — `triedSelectors` only fills when act/observe resolved
          // something) so an optional step that did find a target but failed
          // to verify still runs the full healing cascade.
          if (optional && attempt === 2 && triedSelectors.length === 0) {
            record.verifiedBy = null;
            attempts.push(record);
            logger.info(
              `step ${stepIndex + 1} skipped (optional, no candidates after act+observe)`
            );
            return;
          }
        } else {
          const target = candidates[0]!;
          record.instruction = target.description;
          triedSelectors.push(target.selector);
          record.triedSelectors = [target.selector];
          const result = await stagehand.act(target, { timeout: STEP_WATCHDOG_MS });
          record.actResultSuccess = result.success;
          record.actResultDescription = result.actionDescription;
          // observe(...)[0] is what Stagehand acted on; use it directly when
          // result.actions[] is empty (some Stagehand paths don't echo it back).
          resolvedAction = result.actions?.[0] ?? target;
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
          const candidates = await stagehand
            .observe(step, { timeout: STEP_WATCHDOG_MS })
            .catch(() => [] as Action[]);
          // Fetch live-page evidence so the rephrase prompt can reason about
          // form state, not just observe candidates. Mirrors the same
          // extraction the cascade-exhaust dump path already does.
          const livePageEvidence = await extractLivePageFormEvidence(page);
          // Unfocused observe so the rephrase prompt can see ambient UI
          // like modal Save/Close buttons that the focused candidates
          // (filtered by the failed step's instruction) would hide.
          const unfocused = await stagehand
            .observe({ timeout: STEP_WATCHDOG_MS })
            .catch(() => [] as Action[]);
          const submitFailureList = extractSubmitFailureEvidence(
            recentCaptures,
            submitEndpointPattern ? new RegExp(submitEndpointPattern) : null
          );
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
            priorAttemptsForPrompt
          );
          if (!rephrased) {
            record.errorMessage = "llm declined to rephrase or returned IMPOSSIBLE";
          } else {
            record.instruction = rephrased;
            const result = await stagehand.act(rephrased, { timeout: STEP_WATCHDOG_MS });
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
      logBillingErrorIfPresent(record.errorMessage);
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
    let verified = networkFired || urlChanged || domVerified;

    // Final-step pattern gate. When the flow declared a submit endpoint
    // pattern, we additionally require at least one same-origin POST in this
    // attempt's mutation window whose URL matches the pattern. Without this,
    // clicks that only fire client-side handlers (e.g. analytics beacons that
    // sneak past same-origin filtering, or clicks that bump htmlDelta via a
    // disabled-button tooltip) get a false-positive verified=true.
    if (verified && requireSubmitEndpoint && compiledSubmitPattern) {
      // Cap the scan from preMetaLength so we don't accept a historical
      // submit-shaped capture from an earlier step as proof for this one.
      const tail = recentCaptureMeta.slice(preMetaLength);
      const matched = tail.some((m) => compiledSubmitPattern.test(m.url));
      if (!matched) {
        // DOM-state fallback. Some SPAs swap the form for a thank-you
        // component faster than the network capture pipeline records the
        // submit POST — the verifier sees zero matching captures even
        // though the submit went through. If the flow declared any
        // submittedStateSelectors and ANY is present in the DOM right
        // now, treat the submit as verified via the DOM marker.
        let domSubmittedMatch: string | null = null;
        if (submittedStateSelectors.length > 0) {
          // page.evaluate via template string keeps the DOM globals out of
          // the Node TS scope. Each selector is JSON-stringified so an
          // accidental quote/backslash in the flow file can't break out
          // of the inlined JS expression.
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
              `submitted-state DOM probe threw: ${toErrorMessage(err)} — falling back to network-only verdict`
            );
          }
        }
        if (domSubmittedMatch !== null) {
          logger.info(
            `submit verified via submitted-state DOM selector '${domSubmittedMatch}' (network capture missed the attempt window)`
          );
          record.verifiedBy = "submitted-state-dom";
        } else {
          verified = false;
          record.errorMessage =
            (record.errorMessage ?? "") +
            (record.errorMessage ? "; " : "") +
            `submit-endpoint-not-matched: pattern ${submitEndpointPattern!} did not match any of ${tail.length} attempt-window capture(s)`;
          failureReasons.push(
            `submit-endpoint-not-matched: ${tail.length} capture(s) seen, none matched ${submitEndpointPattern!}`
          );
          // Any-4xx fallback. When the configured submit pattern didn't
          // match BUT some same-window capture returned a 4xx (CSRF
          // redirect to /errors, generic CDN error page, etc.), the
          // structured field-level error JSON in that 4xx body is still
          // actionable for the rephrase prompt. Surface it as a separate
          // failureReason so the LLM sees the server's actual rejection
          // reason instead of just "endpoint pattern didn't match".
          const fallbackEvidence = extractSubmitFailureEvidence(
            recentCaptures.slice(-tail.length),
            null,
            CAPTURES_DIR,
            "any-4xx"
          );
          if (fallbackEvidence.length > 0) {
            failureReasons.push(
              `any-4xx fallback: ${fallbackEvidence.split("\n")[0]}`.slice(0, 240)
            );
          }
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
          // .checked. ClearCompany's formField.js delegated "click .form-checkbox"
          // handler (optionSelected) reads state via .is(':checked') — if the
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
              const r = document.evaluate(${JSON.stringify(xpath)}, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
              let node = r.singleNodeValue;
              if (!node) return false;
              const rx = /(ng-invalid|mat-form-field-invalid|is-invalid|field-invalid|input-invalid)/;
              for (let depth = 0; depth < 6 && node; depth++) {
                const cls = node.getAttribute && node.getAttribute("class");
                if (cls && rx.test(cls)) return true;
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
          let retryVerified =
            retryNetworkFired ||
            retryUrlChanged ||
            retryHtmlDelta !== 0 ||
            retryTextChanged ||
            checkboxStateVerified;
          // Apply the same submit-endpoint gate the primary verifier uses.
          // Without this, the n+16 fallback would still ride past a
          // tracking-pixel-only click on the final step (DOM mutates via a
          // disabled-button tooltip, htmlDelta != 0, fallback declares victory).
          if (retryVerified && requireSubmitEndpoint && compiledSubmitPattern) {
            const tail = recentCaptureMeta.slice(preMetaLength);
            const matched = tail.some((m) => compiledSubmitPattern.test(m.url));
            if (!matched) {
              // Same submitted-state DOM fallback as the primary verifier:
              // accept SPA thank-you transitions when the network capture
              // misses the submit POST within the attempt window.
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
              if (domSubmittedMatch !== null) {
                logger.info(
                  `n+16 fallback submit verified via submitted-state DOM selector '${domSubmittedMatch}'`
                );
                record.verifiedBy = "submitted-state-dom";
              } else {
                retryVerified = false;
                failureReasons.push(
                  `n+16 fallback: submit-endpoint-not-matched: ${tail.length} capture(s) seen, none matched ${submitEndpointPattern!}`
                );
              }
            }
          }
          logger.info(
            `n+16 probe: step=${stepIndex + 1} attempt=${attempt} el.click() fallback fired=${fired === true} kind=${probeResult.kind ?? "none"} checkboxStateVerified=${checkboxStateVerified} ancestorStillInvalid=${ancestorStillInvalid}; network=${retryNetworkFired} url=${retryUrlChanged} htmlDelta=${retryHtmlDelta} textChanged=${retryTextChanged} verified=${retryVerified}`
          );
          if (retryVerified) {
            if (record.verifiedBy === null) {
              record.verifiedBy = retryUrlChanged ? "url" : retryNetworkFired ? "network" : "dom";
            }
            record.post = retryPost;
            attempts.push(record);
            if (attempt > 1) {
              logger.info(
                `step ${stepIndex + 1} healed on attempt ${attempt} via ${record.technique} + el.click() fallback`
              );
            }
            trajectory?.push({ stepIndex, verifiedBy: record.verifiedBy });
            return;
          }
        } catch (probeErr) {
          logger.warn(
            `n+16 probe: step=${stepIndex + 1} attempt=${attempt} el.click() fallback threw: ${toErrorMessage(probeErr)}`
          );
        }
      }
    }

    attempts.push(record);

    if (verified) {
      if (attempt > 1) {
        logger.info(
          `step ${stepIndex + 1} healed on attempt ${attempt} via ${record.technique} (network=${networkFired} url=${urlChanged} dom=${domVerified})`
        );
      }
      trajectory?.push({ stepIndex, verifiedBy: record.verifiedBy });
      return;
    }

    const effectSignals = describeAttemptEffectSignals(pre, post, recentCaptureMeta, preMetaLength);
    const reason = record.errorMessage
      ? effectSignals
        ? `${record.errorMessage}; ${effectSignals}`
        : record.errorMessage
      : effectSignals || "no observable effect (no network, url, or dom change)";
    failureReasons.push(reason);
    logger.warn(
      `step ${stepIndex + 1} attempt ${attempt} (${record.technique}) produced no observable effect — ${reason}`
    );

    // Telemetry-driven early-exit: when attempt 1 on a final-Submit click
    // reveals new ng-invalid containers, attempts 2-N cannot succeed (the
    // form will keep blocking the POST until the new questions are answered).
    // Break out of the attempt loop so the dump runs and the step raises
    // terminal failure → replan triggers immediately, saving the cascade
    // budget that would otherwise burn on identical retries of a click the
    // page is structurally rejecting.
    if (attempt === 1) {
      const postAttemptInvalidCount = await countNgInvalidContainers(page);
      const earlyExit = isSubmitRevealedInvalid({
        isFinalStep,
        requireSubmitEndpoint,
        resolvedMethod: record.resolvedMethod,
        effectSignals,
        preSubmitInvalidCount,
        postAttemptInvalidCount,
      });
      if (earlyExit) {
        const exitReason = `submit-revealed-invalid: click surfaced ${postAttemptInvalidCount - preSubmitInvalidCount} new ng-invalid container(s) (was ${preSubmitInvalidCount}, now ${postAttemptInvalidCount}); attempts 2-${MAX_STEP_ATTEMPTS} cannot heal a form that needs answers — routing to replan`;
        failureReasons.push(exitReason);
        logger.warn(`step ${stepIndex + 1} ${exitReason}`);
        break;
      }
    }
  }

  const finalObserve = await stagehand
    .observe(step, { timeout: STEP_WATCHDOG_MS })
    .catch(() => [] as Action[]);
  const pageTitle = await page.title().catch(() => "");
  // Discriminator data for "Stagehand sees nothing" failures: capture the raw
  // DOM and an unfocused observe so a triager can tell empty-page from
  // Stagehand-can't-see-it without reproducing the failure.
  const bodyOuterHtmlRaw = await page
    .evaluate("document.body ? document.body.outerHTML : null")
    .catch(() => null);
  const bodyOuterHtml =
    typeof bodyOuterHtmlRaw === "string" ? bodyOuterHtmlRaw.slice(0, 100_000) : null;
  const unfocusedObserve = await stagehand
    .observe({ timeout: STEP_WATCHDOG_MS })
    .catch(() => [] as Action[]);
  const dumpPath = dumpStepFailure({
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
  });
  logger.error(
    `step ${stepIndex + 1} failed after ${MAX_STEP_ATTEMPTS} attempts; diagnostic bundle: ${dumpPath}`
  );
  throw new StepVerificationError(
    `step ${stepIndex + 1} (${step.slice(0, 60)}) failed verification after ${MAX_STEP_ATTEMPTS} attempts; see ${dumpPath}`,
    "cascade-exhausted"
  );
}

/** Default resume fixture path; overridable via --resume-fixture or RESUME_FIXTURE_PATH. */
const DEFAULT_RESUME_FIXTURE_PATH = "src/sites/_shared/fixtures/resume.pdf";

function parseCli(): {
  url: string;
  flow: NormalizedStep[];
  flowFile: string | null;
  provider: ProviderName | undefined;
  resumeFixturePath: string;
  saveReplan: boolean;
  advancedStealth: boolean;
  dumpDomBeforeStep: number | null;
  allocateEmailEnvVar: string | null;
  submitEndpointPattern: string | null;
  submittedStateSelectors: string[];
  originalShape: "array" | "object";
} {
  const args = process.argv.slice(2);
  let url = "";
  let rawFlow: unknown = null;
  let flowFile: string | null = null;
  let provider: ProviderName | undefined;
  // Precedence: --resume-fixture flag > RESUME_FIXTURE_PATH env > default path.
  let resumeFixturePath = process.env.RESUME_FIXTURE_PATH || DEFAULT_RESUME_FIXTURE_PATH;
  let saveReplan = true;
  let advancedStealth = false;
  let dumpDomBeforeStep: number | null = null;
  let allocateEmailEnvVar: string | null = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--url" && args[i + 1]) {
      url = args[++i]!;
    } else if (args[i] === "--flow" && args[i + 1]) {
      rawFlow = JSON.parse(args[++i]!);
    } else if (args[i] === "--flow-file" && args[i + 1]) {
      flowFile = resolve(args[++i]!);
    } else if (args[i] === "--provider" && args[i + 1]) {
      const raw = args[++i]!.toLowerCase();
      if (raw !== "browserbase" && raw !== "steel") {
        logger.error(`--provider must be "browserbase" or "steel" (got ${JSON.stringify(raw)})`);
        process.exit(1);
      }
      provider = raw;
    } else if (args[i] === "--resume-fixture" && args[i + 1]) {
      resumeFixturePath = args[++i]!;
    } else if (args[i] === "--no-save-replan") {
      saveReplan = false;
    } else if (args[i] === "--advanced-stealth") {
      advancedStealth = true;
    } else if (args[i] === "--dump-dom-before-step" && args[i + 1]) {
      const n = Number.parseInt(args[++i]!, 10);
      if (!Number.isInteger(n) || n < 1) {
        logger.error(
          `--dump-dom-before-step must be a positive integer (got ${JSON.stringify(args[i])})`
        );
        process.exit(1);
      }
      dumpDomBeforeStep = n;
    } else if (args[i] === "--allocate-email" && args[i + 1]) {
      const name = args[++i]!;
      if (!/^[A-Z_][A-Z0-9_]*$/.test(name)) {
        logger.error(
          `--allocate-email value must be an UPPERCASE_SNAKE_CASE env var name (got ${JSON.stringify(name)})`
        );
        process.exit(1);
      }
      allocateEmailEnvVar = name;
    }
  }

  if (!url) {
    logger.error(
      'usage: recon-browser.ts --url <url> [--flow \'["step1","step2"]\'] [--flow-file <path>] [--provider browserbase|steel] [--resume-fixture <path>] [--no-save-replan] [--advanced-stealth] [--dump-dom-before-step <N>] [--allocate-email <ENV_VAR_NAME>]'
    );
    process.exit(1);
  }

  if (flowFile) {
    if (rawFlow !== null) {
      logger.warn("recon-browser: --flow-file takes precedence over --flow");
    }
    try {
      rawFlow = JSON.parse(readFileSync(flowFile, "utf8"));
    } catch (err) {
      logger.error(`failed to read --flow-file ${flowFile}: ${toErrorMessage(err)}`);
      process.exit(1);
    }
  }

  if (rawFlow === null) {
    return {
      url,
      flow: [],
      flowFile,
      provider,
      resumeFixturePath,
      saveReplan,
      advancedStealth,
      dumpDomBeforeStep,
      allocateEmailEnvVar,
      submitEndpointPattern: null,
      submittedStateSelectors: [],
      originalShape: "array",
    };
  }
  const parsed = RECON_FLOW_FILE_SCHEMA.safeParse(rawFlow);
  if (!parsed.success) {
    logger.error(`flow file/arg failed schema validation: ${parsed.error.message}`);
    process.exit(1);
  }
  const stepsRaw = Array.isArray(parsed.data) ? parsed.data : parsed.data.steps;
  const submitEndpointPattern = Array.isArray(parsed.data)
    ? null
    : (parsed.data.submitEndpointPattern ?? null);
  const submittedStateSelectors = Array.isArray(parsed.data)
    ? []
    : (parsed.data.submittedStateSelectors ?? []);
  const isArrayShape = Array.isArray(parsed.data);
  // Validate regex compiles eagerly so a malformed pattern fails the run
  // at startup, not deep in a per-step verifier.
  if (submitEndpointPattern !== null) {
    try {
      new RegExp(submitEndpointPattern);
    } catch (err) {
      logger.error(`flow file: submitEndpointPattern is not a valid regex: ${toErrorMessage(err)}`);
      process.exit(1);
    }
  }
  return {
    url,
    flow: normalizeFlow(stepsRaw),
    flowFile,
    provider,
    resumeFixturePath,
    saveReplan,
    advancedStealth,
    dumpDomBeforeStep,
    allocateEmailEnvVar,
    submitEndpointPattern,
    submittedStateSelectors,
    originalShape: isArrayShape ? "array" : "object",
  };
}

/**
 * Loads the resume fixture from disk at startup so the upload primitive
 * doesn't re-read the file from disk for every recon step. Returns null
 * when the file doesn't exist — the primitive then falls through to the
 * regular cascade and the recon continues unchanged (so flows that don't
 * involve resume uploads aren't affected by a missing fixture).
 */
function loadResumeFixture(
  path: string
): { buffer: Buffer; name: string; mimeType: string } | null {
  try {
    const buffer = readFileSync(path);
    const name = path.split("/").pop() ?? "resume.pdf";
    // Conservative: every site we've targeted accepts PDF; if we ever ship a
    // .docx fixture we'd extend this map. Default keeps the primitive safe.
    const mimeType = name.toLowerCase().endsWith(".pdf")
      ? "application/pdf"
      : "application/octet-stream";
    return { buffer, name, mimeType };
  } catch (err) {
    logger.warn(
      `resume fixture not loaded from ${path}: ${toErrorMessage(err)} — upload primitive will fall through`
    );
    return null;
  }
}

async function main(): Promise<void> {
  const {
    url,
    flow: rawFlow,
    flowFile,
    provider,
    resumeFixturePath,
    saveReplan,
    advancedStealth,
    dumpDomBeforeStep,
    allocateEmailEnvVar,
    submitEndpointPattern,
    submittedStateSelectors,
    originalShape,
  } = parseCli();

  // Allocate a fresh testmail.app inbox + bind it to the requested env var
  // BEFORE substituting placeholders in the flow. Subsequent ${ENV_VAR}
  // tokens anywhere in the flow's instruction strings resolve to the
  // freshly-allocated address.
  if (allocateEmailEnvVar) {
    const inbox = allocateTestmailInbox();
    process.env[allocateEmailEnvVar] = inbox.address;
    logger.info(
      `bound allocated testmail address to env var ${allocateEmailEnvVar}=${inbox.address}`
    );
  }

  const flow = substituteFlowEnvVars(rawFlow);

  mkdirSync(CAPTURES_DIR, { recursive: true });
  const resumeFixture = loadResumeFixture(resumeFixturePath);
  logger.info(
    `recon-browser: target=${url} flow_steps=${flow.length} provider=${provider ?? "(config-default)"} advancedStealth=${advancedStealth} resume_fixture=${resumeFixture ? `${resumeFixturePath} (${resumeFixture.buffer.length}b)` : "(missing)"} out=${CAPTURES_DIR}`
  );

  const session = await createBrowserSession({ provider, advancedStealth });
  // `counter` indexes captures on disk (filenames must stay unique).
  // `signalCounter` drives the verifier — only non-GET methods increment
  // it so coincident polling/page-load GETs don't falsely "verify" a
  // click that produced no real effect. See the onFinished comment in
  // wireNetworkCapture for the rationale.
  const counter = { n: 0 };
  const signalCounter = { n: 0 };
  const recentCaptures: string[] = [];
  // Parallel tracker of recent non-GET captures' method + status. Used by
  // the Tier 1 trailing-optional-step grace: a verification failure on an
  // optional trailing step is treated as a benign no-op when a recent
  // mutation returned 2xx (i.e. the SPA's "real work" already completed
  // server-side and the trailing step is a redundant tail that the flow
  // file may have included for sites where it's actually needed). GETs are
  // filtered at the push site so the window isn't washed out by SPA chunk
  // loads — see the comment in wireNetworkCapture's onFinished.
  const recentCaptureMeta: { method: string; status: number; url: string }[] = [];

  // Hoisted out of the try block so the finally can run the replan
  // write-back even when the cascade throws — replan-discovered steps
  // accumulated up to the failure point should survive a cascade-exhausted
  // exit so the user can review them and the next run starts where this
  // one left off. The "only on success" gate before was the reason most
  // recon discoveries got thrown away on failed runs.
  const plan: NormalizedStep[] = [];
  const replanEvents: ReplanEvent[] = [];

  try {
    const stagehand = session.stagehand;
    const page = await stagehand.context.awaitActivePage();

    // Phase label is mutated between flow steps so the single CDP listener
    // always tags captures with the currently active phase.
    let currentPhase = "home";
    const stopCapture = wireNetworkCapture(
      page,
      counter,
      signalCounter,
      recentCaptures,
      recentCaptureMeta,
      () => currentPhase,
      () => {
        // Live read so SPA history navigation between captures stays accurate.
        // Fallback to the initial url on parse failure (e.g. about:blank early
        // in the goto cycle) so we don't accidentally mark a capture as
        // cross-origin and miss the user-action signal.
        try {
          return new URL(page.url()).origin;
        } catch {
          return new URL(url).origin;
        }
      }
    );

    logger.info(`navigating to ${url}`);
    await page.goto(url, { waitUntil: "domcontentloaded", timeoutMs: GOTO_TIMEOUT_MS });

    const anthropic = buildAnthropicClient();
    if (!anthropic) {
      logger.warn(
        "bedrock-only deployment: attempt-4 llm rephrase and global replan will be skipped on step failures"
      );
    }

    plan.push(...flow);
    const completedSteps: string[] = [];
    const trajectory: { stepIndex: number; verifiedBy: AttemptRecord["verifiedBy"] }[] = [];
    let probeReplansUsed = 0;
    let cascadeReplansUsed = 0;

    for (let i = 0; i < plan.length; i++) {
      const step = plan[i]!;
      currentPhase =
        step.instruction
          .replace(/[^a-z0-9]+/gi, "-")
          .toLowerCase()
          .replace(/^-|-$/g, "")
          .slice(0, 24) || `step-${i}`;
      logger.info(
        `step ${i + 1}/${plan.length} [${currentPhase}]${step.optional ? " (optional)" : ""}: ${step.instruction}`
      );
      // Debug: dump the full DOM right before this step's cascade runs. Lets
      // a triager see the page state exactly as the cascade sees it, without
      // re-running. One-shot per recon run via --dump-dom-before-step.
      if (dumpDomBeforeStep !== null && i + 1 === dumpDomBeforeStep) {
        try {
          const html = await page.evaluate(
            "document.documentElement ? document.documentElement.outerHTML : ''"
          );
          if (typeof html === "string" && html.length > 0) {
            const dumpPath = join(CAPTURES_DIR, `..`, `dom-dump-step-${i + 1}.html`);
            writeFileSync(dumpPath, html);
            logger.info(`step ${i + 1}: wrote DOM dump (${html.length} bytes) to ${dumpPath}`);
          } else {
            logger.warn(`step ${i + 1}: DOM dump returned empty content; skipping write`);
          }
        } catch (err) {
          logger.warn(`step ${i + 1}: DOM dump failed: ${toErrorMessage(err)}`);
        }
      }
      try {
        await executeStepWithHealing({
          stagehand,
          page,
          step: step.instruction,
          optional: step.optional,
          upload: step.upload,
          stepIndex: i,
          phase: currentPhase,
          signalCounter,
          recentCaptures,
          recentCaptureMeta,
          anthropic,
          logger,
          resumeFixture,
          isFinalStep: i === plan.length - 1,
          submitEndpointPattern,
          submittedStateSelectors,
          trajectory,
        });
        completedSteps.push(step.instruction);
      } catch (err) {
        if (!(err instanceof StepVerificationError)) throw err;

        // Unrecoverable backend-error short-circuit. When the cascade
        // detected a same-window 5xx on the submit endpoint, no amount of
        // replan or rephrase can heal a server crash. Propagate the error
        // out of the flow loop so main()'s outer try/catch reports the
        // diagnostic — bypasses the trailing-grace and replan paths
        // entirely. (The cascade-exhausted and probe-absent kinds fall
        // through to the existing dispatcher below.)
        if (err.kind === "backend-error-unrecoverable") {
          logger.error(`backend error unrecoverable: ${err.message}; aborting run`);
          throw err;
        }

        // Tier 1 — trailing-optional-step grace: when an OPTIONAL step at
        // trailing position fails verification AND a recent non-GET capture
        // returned 2xx, treat as a benign no-op exit. The flow's "real work"
        // already completed server-side (recent successful POST proves it);
        // the trailing step is a redundant tail that the cascade can't make
        // meaningful progress on (e.g. resume re-upload after the workflow
        // already ended, final Continue when the Submit button is in
        // "Saving..." state). Uses only flow-position metadata + capture HTTP
        // metadata — no content matching, no open-set patterns.
        if (step.optional && i >= plan.length - TRAILING_GRACE_WINDOW) {
          const recentMutationSucceeded = recentCaptureMeta.some(
            (m) => m.method !== "GET" && m.status >= 200 && m.status < 300
          );
          if (recentMutationSucceeded) {
            logger.info(
              `step ${i + 1} optional + trailing position; recent non-GET 2xx captured — treating verification failure as benign no-op; recon complete`
            );
            break;
          }
        }

        if (!anthropic) throw err;

        // Cause-based replan budget. Probe replans are cheap (one observe +
        // one LLM call to detect "wrong page"), cascade replans are expensive
        // (four attempts × backoff + observe + LLM rephrase before we know
        // the step is unrecoverable). Separate budgets so cheap recoveries
        // don't eat into the budget reserved for expensive ones.
        const isProbe = err.kind === "probe-absent";
        const budget = isProbe ? MAX_PROBE_REPLANS : MAX_CASCADE_REPLANS;
        const usedSoFar = isProbe ? probeReplansUsed : cascadeReplansUsed;
        if (usedSoFar >= budget) {
          const kindsSummary = summarizeReplanFailureKinds({
            callsNdjsonPath: config.telemetry.callsNdjsonPath,
            callType: CALL_TYPE_RECON_REPLAN,
            tailCount: budget * 2,
          });
          const kindsSuffix = kindsSummary ? ` — ${kindsSummary}` : "";
          logger.error(
            `step ${i + 1} ${err.kind} replan budget exhausted (${usedSoFar}/${budget}); aborting${kindsSuffix}`
          );
          throw err;
        }

        const replanIndex = replanEvents.length + 1;
        const originalRemaining = plan.slice(i + 1);
        const dumpMatch = err.message.match(/see (\/[^\s]+)$/);
        const dumpPath = dumpMatch ? dumpMatch[1]! : "";
        logger.warn(
          `step ${i + 1} terminally failed (${err.kind}); attempting global replan #${replanIndex} (${isProbe ? "probe" : "cascade"} budget ${usedSoFar + 1}/${budget})`
        );

        const newSteps = await replanRemainingFlow({
          client: anthropic,
          originalFlow: flow.map((s) => s.instruction),
          completedSteps,
          failedStep: step.instruction,
          remainingSteps: originalRemaining.map((s) => s.instruction),
          failureDumpPath: dumpPath,
          page,
          stagehand,
          recentCaptures,
          submitEndpointPattern: submitEndpointPattern ? new RegExp(submitEndpointPattern) : null,
          trajectory,
        });

        if (!newSteps) {
          logger.error(
            `replan #${replanIndex} returned IMPOSSIBLE or unparseable output; aborting`
          );
          throw err;
        }

        if (isProbe) {
          probeReplansUsed++;
        } else {
          cascadeReplansUsed++;
        }
        replanEvents.push({
          replanIndex,
          cause: err.kind,
          indexAtFailure: i,
          failedInstruction: step.instruction,
          replanSteps: newSteps,
          timestamp: formatISO(new Date()),
        });

        const replanPath = dumpReplanRecord({
          stepIndex: i,
          phase: currentPhase,
          replanIndex,
          completedSteps,
          originalRemaining: originalRemaining.map((s) => s.instruction),
          newRemaining: newSteps.map((s) => s.instruction),
        });
        logger.info(
          `replan #${replanIndex} produced ${newSteps.length} new step(s); resuming (record: ${replanPath})`
        );
        for (const [j, s] of newSteps.entries()) {
          logger.info(
            `  replanned step ${j + 1}${s.optional ? " (optional)" : ""}: ${s.instruction}`
          );
        }

        // Prepend recovery steps before the original remaining tail — the
        // replanner emits bridge steps from the failure point back to where
        // the original flow can resume. Idempotent fills/clicks on already-
        // satisfied form fields cost a few seconds each but keep the rest of
        // the original intent (page-0 Continue, page-1 sections, resume
        // upload, final submit) intact instead of replacing them with the
        // replanner's necessarily-truncated tail (capped at REPLAN_MAX_STEPS).
        // Tag replan-discovered steps with origin so persistReplannedFlow
        // can force them optional on write-back. originalRemaining keeps its
        // origin: "original" — that's what protects the canonical final
        // submit from being silently demoted to optional across replans.
        const taggedNewSteps = newSteps.map((s) => ({ ...s, origin: "replan" as const }));
        plan.splice(i, plan.length - i, ...taggedNewSteps, ...originalRemaining);
        i--;
      }
    }

    stopCapture();
    logger.info(`recon complete — ${counter.n} captures written to ${CAPTURES_DIR}`);
  } finally {
    // Replay-the-discovered-path: if any replan fired and the user provided
    // a flow file, write the improved plan back so the next run starts
    // where this one ended up. Runs INSIDE finally so the cascade's
    // discoveries survive cascade-exhausted exits too — the persistence
    // mechanism is the way recon self-heals the flow across runs, so it
    // needs to fire on failure as much as on success. Skipped on
    // --no-save-replan (diagnostic dry-runs) and when --flow was used
    // inline (no file to write back to).
    if (replanEvents.length > 0) {
      if (!saveReplan) {
        logger.info(
          `run done with ${replanEvents.length} replan event(s); --no-save-replan, leaving flow.json unchanged`
        );
      } else if (!flowFile) {
        logger.info(
          `run done with ${replanEvents.length} replan event(s); --flow used (no file to write back to)`
        );
      } else {
        logger.info(`run done; writing flow.json with ${replanEvents.length} replan event(s)`);
        try {
          persistReplannedFlow({
            flowFile,
            finalPlan: plan,
            replanEvents,
            logger,
            originalShape,
            submitEndpointPattern,
            submittedStateSelectors,
          });
        } catch (err) {
          // Persistence is best-effort in the finally block — a write
          // failure here must not eat the original cascade error.
          logger.error(`persistReplannedFlow threw in finally: ${toErrorMessage(err)}`);
        }
      }
    }
    await session.close();
  }
}

if (
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith("recon-browser.ts") || process.argv[1].endsWith("recon-browser.js"))
) {
  main().catch((err) => {
    // StagehandDefaultError wraps the real cause with a verbose "Hey! We're sorry..." banner.
    // Unwrap it so the log shows just the meaningful error message.
    const message =
      err instanceof Error && err.cause instanceof Error ? err.cause.message : toErrorMessage(err);
    logger.error(`recon-browser failed: ${message}`);
    process.exit(1);
  });
}

export type { InvalidFormControl, NormalizedStep, ReplanEvent };
// Test-only exports — allow unit tests to inject a fake capture sink without
// touching the main() entry-point or the real browser session.
export {
  dedupeConsecutiveIdentical,
  denormalizeStep,
  narrowInvalidFormControl,
  persistReplannedFlow,
  readFailureDumpEvidence,
  renderUnfocusedObserve,
  rephraseWithLLM,
  replanRemainingFlow,
};
