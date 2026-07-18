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
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import type Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { Action, LoadState, Page, Stagehand } from "@browserbasehq/stagehand";
import { format, formatISO } from "date-fns";
import { z } from "zod/v4";

import { toErrorMessage } from "@/lib/errors";
import { configureHttpDispatcher } from "@/lib/http";
import { buildAnthropicClient } from "@/lib/llm/anthropic-client";
import { judgeErrorMessagesWithLLM } from "@/lib/llm/judges/error-messages";
import { judgeInvalidFieldsWithLLM } from "@/lib/llm/judges/invalid-fields";
import { verifySubmitWithLLM } from "@/lib/llm/judges/verify-submit";
import {
  RECON_FLOW_STEP_SCHEMA,
  REPLAN_MAX_STEPS,
  REPLAN_RESPONSE_SCHEMA,
} from "@/lib/llm/schemas";
import { getScriptLogger } from "@/lib/logging";
import { captureLlmCall, classifyLlmCallFailure } from "@/lib/telemetry/call-capture";
import { CALL_TYPE_RECON_REPLAN } from "@/lib/telemetry/call-types";
import {
  resolveRunCallsPath,
  resolveRunUrlPath,
  resolveSiteTelemetryDir,
} from "@/lib/telemetry/telemetry-paths";
import { captureCookieJarSnapshot } from "@/scraper/cookie-jar";
import { StepVerificationError } from "@/scraper/errors";
import {
  type AttemptRecord,
  anthropicModelName,
  type CaptureFn,
  capturesAfterIndex,
  executeStepWithHealing,
  extractGaEventEvidence,
  extractSubmitFailureEvidence,
  GOTO_TIMEOUT_MS,
  latestCaptureIndex,
  logBillingErrorIfPresent,
  probeLeafInvalidContainers,
  renderLeafInvalidFields,
  renderUnfocusedObserve,
  STEP_WATCHDOG_MS,
  selectBodyExcerpt,
  snapshotPage,
  TRAILING_GRACE_WINDOW,
  waitForSpaReady,
  wireSignalCapture,
} from "@/scraper/flow-runner";
import { createBrowserSession, type ProviderName } from "@/scraper/session";
import { guardedObserve } from "@/scraper/stagehand-guard";
import { filterByCallType, parseSamples } from "@/scripts/judge-llm-batch";
import { CAPTURES_DIR, COOKIES_DIR, STEP_FAILURES_DIR } from "@/scripts/recon-shared";
import { allocateTestmailInbox } from "@/testmail/client";
import type { Logger } from "@/types/logging";

configureHttpDispatcher();

const logger = getScriptLogger("recon-browser");

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
  pageState: { url: string; htmlLength: number };
}

/**
 * Identical-proposal threshold for {@link isReplanCycle}. Set to a value
 * high enough that one repeat plus one retry under the page-state guard
 * doesn't trip — only a sustained fixed point should. Below 3, legitimate
 * "same proposal under slightly-different state" retries can produce false
 * cycle detections.
 */
const REPLAN_CYCLE_THRESHOLD = 3;

/**
 * Maximum bodyHtmlLength delta (in chars) at which two replan attempts are
 * treated as targeting the same page state. Separates incidental DOM churn
 * (framework attribute updates, focus rings, single-element re-renders;
 * typically single-to-low-double-digit char deltas) from real page
 * transitions (typically kilobyte-scale once new sections render).
 */
const HTML_STATIC_TOLERANCE = 100;

/**
 * Thin CLI wrapper over {@link wireSignalCapture}: owns the on-disk capture
 * layout (writes each capture — and its decoded-params sidecar — under
 * `CAPTURES_DIR`) while delegating all in-memory capture bookkeeping to the
 * shared flow-runner engine. Kept here so the persistence policy stays with
 * the recon entry-point and `flow-runner.ts` remains filesystem-agnostic.
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
  return wireSignalCapture(page, {
    counter,
    signalCounter,
    recentCaptures,
    recentCaptureMeta,
    getCurrentPhase,
    getCurrentPageOrigin,
    onCapture: (capture, filename) => {
      // Defense in depth: a future edge case (NFS, symlink loop, full disk)
      // shouldn't crash the whole recon run. Drop the capture, log loudly,
      // and let the cascade continue. The capture is forensic-only — the
      // happy-path doesn't read these files until something else fails.
      try {
        writeFileSync(join(CAPTURES_DIR, filename), JSON.stringify(capture, null, 2));
        if (capture.decodedParams !== null && capture.decodedParams !== capture.requestPostData) {
          const decodedFilename = filename.replace(/\.json$/, ".decoded.json");
          writeFileSync(
            join(CAPTURES_DIR, decodedFilename),
            JSON.stringify(capture.decodedParams, null, 2)
          );
        }
      } catch (err) {
        logger.warn(
          `capture-write skipped for ${capture.url.slice(0, 80)}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    },
  });
}

/**
 * Reads the browser's full cookie jar for the given phase and writes it under
 * `COOKIES_DIR`, so a run's snapshots land in the same append-only, diffable
 * layout as `wireNetworkCapture`'s network captures. `counter` indexes
 * filenames chronologically (zero-padded, shared convention with
 * flow-runner's capture counter) so snapshots sort in the order the phases
 * actually occurred. Never throws — cookie telemetry is best-effort, matching
 * the existing capture-write behavior: a write failure logs a warning and the
 * recon run continues.
 */
async function snapshotAndPersistCookieJar(
  page: Page,
  counter: { n: number },
  label: string,
  phase: string,
  stepIndex: number
): Promise<void> {
  const snapshot = await captureCookieJarSnapshot(page, label, phase, stepIndex);
  const idx = String(counter.n++).padStart(3, "0");
  const filename = `${idx}-${label}-${phase}.json`;
  try {
    writeFileSync(join(COOKIES_DIR, filename), JSON.stringify(snapshot, null, 2));
  } catch (err) {
    logger.warn(`cookie-snapshot-write skipped for ${filename}: ${toErrorMessage(err)}`);
  }
}

const MAX_PROBE_REPLANS = 5;
/**
 * Replans triggered by the full self-healing cascade exhausting all 4
 * attempts (expensive: 4 attempts × backoff + LLM rephrase + observe
 * calls). Counted separately from probe replans so cheap recoveries don't
 * consume the budget reserved for expensive recoveries.
 */
const MAX_CASCADE_REPLANS = 5;

/**
 * Validates the RECON_GOTO_WAIT_UNTIL override before it reaches Stagehand,
 * which accepts a narrower set of load states than Playwright does — `commit`
 * is valid in Playwright and rejected here. A typo warns and falls back rather
 * than failing the run at navigation.
 */
export function resolveGotoWaitUntil(raw: string | undefined, log: Logger = logger): LoadState {
  const value = raw?.trim();
  if (!value) return "domcontentloaded";
  if (value === "load" || value === "domcontentloaded" || value === "networkidle") return value;
  log.warn(
    `RECON_GOTO_WAIT_UNTIL=${JSON.stringify(value)} is not a valid load state — falling back to "domcontentloaded"`
  );
  return "domcontentloaded";
}

/**
 * Navigation wait condition for the initial goto.
 *
 * Defaults to `domcontentloaded` rather than `networkidle` because recon's
 * targets are no longer only ATS forms. Ad-heavy commercial sites keep
 * analytics and session-replay beacons on timers, so the network never falls
 * idle for the required 500ms and `networkidle` can never resolve — Playwright
 * marks it DISCOURAGED for exactly this reason and points at readiness
 * assertions instead, which is what the SPA probe after the goto already does.
 *
 * Override with RECON_GOTO_WAIT_UNTIL for a site that genuinely needs the
 * stricter wait (e.g. a form whose scripts must settle before step 1).
 */
const GOTO_WAIT_UNTIL: LoadState = resolveGotoWaitUntil(process.env.RECON_GOTO_WAIT_UNTIL);

export function detectRejectionInResponseBody(body: unknown): {
  rejected: boolean;
  reason: string | null;
} {
  if (!body || typeof body !== "object") return { rejected: false, reason: null };
  const rec = body as Record<string, unknown>;
  if (rec.not_qualified === true) {
    return {
      rejected: true,
      reason: typeof rec.error === "string" ? rec.error : "not_qualified",
    };
  }
  if (rec.rejected === true) {
    return {
      rejected: true,
      reason: typeof rec.reason === "string" ? rec.reason : "rejected",
    };
  }
  if (rec.qualified === false) {
    return {
      rejected: true,
      reason: typeof rec.reason === "string" ? rec.reason : "qualified=false",
    };
  }
  if (typeof rec.status === "string" && rec.status === "rejected") {
    return {
      rejected: true,
      reason: typeof rec.reason === "string" ? rec.reason : "status=rejected",
    };
  }
  return { rejected: false, reason: null };
}

/**
 * Normalize a capture's responseBody to the parsed-object shape that
 * `detectRejectionInResponseBody` expects. Capture writer at
 * recon-browser.ts:240 stores the field as either:
 *   - a parsed OBJECT (the common case — JSON.parse succeeded at capture time)
 *   - a STRING (fallback when JSON.parse failed — raw text body)
 *   - null (CDP body fetch failed; binary; unavailable)
 *
 * Previous version of this helper assumed string-only and returned null for
 * the object case — causing Q1's audit to miss 100% of rejection envelopes
 * because AppCast (and any JSON-serving ATS) lands in the object case.
 * Verified 2026-06-15 against capture 122-...-a4ab5256.json:
 * `jq '.responseBody | type'` returned `"object"`, the broken helper
 * returned null, the audit declared "PASSED" while the body contained
 * `{"not_qualified": true}`.
 *
 * Site-agnostic: every JSON-serving REST endpoint produces the object
 * case; the string-as-JSON fallback covers rare cases where the capture
 * writer stored a parseable JSON string for some reason.
 */
function normalizeResponseBodyForAudit(data: { responseBody?: unknown }): unknown {
  const body = data.responseBody;
  if (body && typeof body === "object") return body;
  if (typeof body === "string") {
    try {
      return JSON.parse(body);
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * End-of-run audit: scan ALL captures written by this run for any 2xx
 * whose URL matches the flow's submitEndpointPattern AND whose response
 * body does NOT indicate a rejection envelope. Returns true when NO clean
 * 2xx match is found — i.e. the run completed without an accepted
 * submission landing. Caller exits non-zero so silent-pass states surface
 * as real failures.
 *
 * The audit is independent of the per-step verifier — the verifier may
 * have accepted a DOM-fallback or URL-change signal as proof, but if
 * the configured submit endpoint never returned 2xx, OR returned 2xx
 * with a rejection envelope (e.g. AppCast's `not_qualified: true`), the
 * application data didn't actually reach the employer's ATS.
 *
 * Site-agnostic: rejection detection is via `detectRejectionInResponseBody`
 * which knows the union of common ATS rejection-envelope shapes
 * (AppCast/Greenhouse/Lever/Workday). New ATSs extend the union.
 *
 * Pre-existing AppCast-specific equivalent: readJobOutcome in
 * recon-replay-jobs.ts. This is the agnostic engine-side version using
 * the flow file's declared pattern.
 */
function auditFinalSubmitMatch(params: {
  /**
   * Hostnames considered "the site's own backend." A 2xx capture whose URL
   * resolves to one of these hostnames is treated as proof the submit
   * landed. Replaces the prior submitEndpointPattern regex with
   * deterministic hostname equality on a URL component — no more URL-path
   * pattern matching at the audit gate. Empty list = audit always returns
   * "no proof of submit" (caller decides what that means).
   */
  ownBackendHostnames: readonly string[];
  capturesDir: string;
  logger: Logger;
}): { auditFailed: boolean; rejectionReason: string | null } {
  const { ownBackendHostnames, capturesDir, logger } = params;
  if (ownBackendHostnames.length === 0) return { auditFailed: true, rejectionReason: null };
  let entries: string[];
  try {
    entries = readdirSync(capturesDir);
  } catch (err) {
    logger.warn(
      `end-of-run audit: could not read captures dir ${capturesDir}: ${toErrorMessage(err)}`
    );
    return { auditFailed: true, rejectionReason: null };
  }
  // Collect the most recent rejection reason in case we don't find a clean
  // 2xx — surfaces "we DID submit but the server rejected" rather than
  // "we never submitted" so the operator knows whether to fix the engine
  // or fix the application content.
  let lastRejectionReason: string | null = null;
  for (const f of entries) {
    try {
      const data = JSON.parse(readFileSync(join(capturesDir, f), "utf8")) as {
        status?: number;
        url?: string;
        responseBody?: unknown;
      };
      if (
        typeof data.url === "string" &&
        typeof data.status === "number" &&
        data.status >= 200 &&
        data.status < 300
      ) {
        let hostname: string;
        try {
          hostname = new URL(data.url).hostname;
        } catch {
          continue;
        }
        if (!ownBackendHostnames.includes(hostname)) continue;
        const parsedBody = normalizeResponseBodyForAudit(data);
        const rejection = detectRejectionInResponseBody(parsedBody);
        if (rejection.rejected) {
          lastRejectionReason = rejection.reason;
          continue;
        }
        return { auditFailed: false, rejectionReason: null };
      }
    } catch {
      // Ignore unparseable capture files — they're either malformed or
      // a different shape (e.g. resource captures that don't have status/url).
    }
  }
  return { auditFailed: true, rejectionReason: lastRejectionReason };
}

export function findWizardRestartSignal(params: {
  preIdx: number;
  capturesDir?: string;
  restartSignalUrlPatterns: readonly string[];
}): string | null {
  const { preIdx, restartSignalUrlPatterns } = params;
  if (restartSignalUrlPatterns.length === 0) return null;
  const capturesDir = params.capturesDir ?? CAPTURES_DIR;
  for (const filename of capturesAfterIndex(preIdx, capturesDir)) {
    let url: string;
    try {
      const raw = readFileSync(join(capturesDir, filename), "utf8");
      const capture = JSON.parse(raw) as { url?: unknown };
      if (typeof capture.url !== "string") continue;
      url = capture.url;
    } catch {
      continue;
    }
    for (const pattern of restartSignalUrlPatterns) {
      if (url.includes(pattern)) return url;
    }
  }
  return null;
}

export function isStructurallyBlocked(
  attempts: readonly {
    triedSelectors: readonly string[];
    verifiedBy: string | null;
  }[]
): boolean {
  if (attempts.length === 0) return false;
  return attempts.every((a) => a.triedSelectors.length === 0 && a.verifiedBy === null);
}

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
 * Detect a true replan cycle: the same multi-step instruction sequence
 * proposed REPLAN_CYCLE_THRESHOLD times in a row under page state that
 * hasn't materially advanced. The page-state guard (URL equality + bounded
 * htmlLength delta) is essential — a re-proposal under genuinely different
 * page state is a valid retry, not a cycle. Without the guard we'd block
 * legitimate "the page advanced; the same step now works" recoveries.
 */
export function isReplanCycle(
  priorReplans: readonly ReplanEvent[],
  newSteps: readonly NormalizedStep[],
  currentState: { url: string; htmlLength: number }
): boolean {
  if (priorReplans.length < REPLAN_CYCLE_THRESHOLD) return false;
  const newSig = newSteps.map((s) => s.instruction).join("|||");
  let identicalCount = 0;
  for (const prior of priorReplans) {
    const priorSig = prior.replanSteps.map((s) => s.instruction).join("|||");
    if (priorSig !== newSig) continue;
    const urlSame = prior.pageState.url === currentState.url;
    const htmlStatic =
      Math.abs(prior.pageState.htmlLength - currentState.htmlLength) < HTML_STATIC_TOLERANCE;
    if (urlSame && htmlStatic) identicalCount++;
  }
  return identicalCount >= REPLAN_CYCLE_THRESHOLD;
}

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
    /**
     * When true, the final-step verifier accepts ONLY a `submitEndpointPattern`
     * network capture as proof of submission — `submittedStateSelectors` DOM
     * matches become a tiebreaker, not a standalone fallback. Use this for
     * SPAs where the success-route component renders optimistically even if
     * the server-side submit was blocked (e.g. by a bot-management WAF), so
     * the DOM marker would otherwise false-positive a failed submission.
     * Default false preserves the lenient pre-existing behavior for sites
     * that genuinely rely on DOM-only verification.
     */
    requireSubmitEndpointMatch: z.boolean().optional(),
    /**
     * URL path fragments that indicate a successful submit transition.
     * Surfaced to the Haiku verifySubmit judge as evidence — when the page
     * URL after the click contains any of these, that's one of the strong
     * signals required for verified=true. Examples: ["/applied",
     * "/applyboard/applied", "/confirmation", "/thank-you"]. Site-specific
     * since URL conventions vary across ATS tenants.
     */
    successUrlFragments: z.array(z.string().min(1)).optional(),
    /**
     * Page-title substrings that indicate a successful submit. Same role as
     * successUrlFragments — strong signal for the Haiku verifySubmit judge.
     * Examples: ["Thank you", "Application submitted", "Submitted
     * successfully", "Confirmation"]. English-only is fine; the judge can
     * still reason about non-English variants from the DOM signals.
     */
    successPageTitleHints: z.array(z.string().min(1)).optional(),
    /**
     * Hostnames considered "the site's own backend." The Haiku
     * verifySubmit judge treats a 2xx POST/PUT/DELETE to one of these
     * hostnames as a corroborating network signal — anything else (e.g.
     * analytics, third-party trackers, CDNs) is ignored. Without this
     * list the judge falls back to the URL alone, which is weaker.
     * Examples: ["apply.appcast.io"], ["careers.<ats>.com",
     * "<tenant>.<ats>.com"].
     */
    ownBackendHostnames: z.array(z.string().min(1)).optional(),
    /**
     * Optional site-specific class-name prefixes that wrap form/error
     * state. The Haiku invalid-fields judge uses these as additional
     * structural evidence beyond framework-conventional patterns
     * (ng-invalid, aria-invalid, data-invalid). Examples for AppCast:
     * ["uapp-", "app-"]. When omitted, the judge falls back to framework
     * conventions alone.
     */
    knownErrorClassPrefixes: z.array(z.string().min(1)).optional(),
    /**
     * Optional site-specific labels for wizard-exit controls (save-and-exit,
     * cancel, restart) — appended to the engine's built-in
     * WIZARD_EXIT_ACTION_LABELS. An "advance / click Next" step whose resolved
     * action description matches one of these is rejected so the cascade never
     * clicks a destructive control. Only add unambiguously-destructive labels.
     */
    wizardExitButtonLabels: z.array(z.string().min(1)).optional(),
    /**
     * Optional URL substrings that signal a multi-page wizard RESTART / backward
     * navigation (e.g. `init-apply`, `application_canceled=true`). When any
     * recent capture URL matches after a step, the run aborts with a
     * `wizard-regression` error instead of running later steps against the reset
     * page or replanning against the restarted wizard.
     */
    restartSignalUrlPatterns: z.array(z.string().min(1)).optional(),
    /**
     * Optional regex matched against the REQUEST BODY of same-window network
     * captures to prove an interior (non-submit) "advance"/"Next" step actually
     * moved the wizard forward — not merely fired some other same-origin POST.
     * Needed for SPAs where advance and non-advance mutations share one endpoint
     * URL (e.g. Talemetry's `/gq`: a real page advance is a `TransitionWorklet`
     * mutation, while `EditQuestionItem` is just a field edit — byte-identical
     * URLs, only the body differs). When set, an advance step's `networkFired`
     * signal is trusted ONLY if a capture body in the step's window matches this
     * pattern. Opt-in: sites that don't set it keep today's behavior (any
     * network/url/dom signal verifies), so no cross-site regression.
     */
    advanceTransitionBodyPattern: z.string().min(1).optional(),
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
  // See RECON_FLOW_STEP_SCHEMA in src/lib/llm/schemas.ts for why this exists:
  // engine gates the pre-submit DOM probe and final-step submit verifier on
  // (isFinalStep || submitStep), not on isFinalStep alone, so flows whose
  // canonical submit click lives mid-flow can still mark it explicitly.
  // Optional in the type so existing test fixtures + call sites that predate
  // the flag don't need to be touched — absence is treated as false.
  submitStep?: boolean;
  // Generator-only splicer hints (see RECON_FLOW_STEP_SCHEMA). Carried through
  // the normalize/denormalize round-trip so a hand-authored flow file's
  // payloadField/payloadFieldNone survives a recon run's write-back and reaches
  // recon-generate.ts. The recon runtime itself never reads them. Optional so
  // pre-existing fixtures and call sites need no changes.
  payloadField?: string;
  payloadFieldNone?: boolean;
  origin: "original" | "replan";
}

function normalizeFlow(steps: z.infer<typeof RECON_FLOW_SCHEMA>): NormalizedStep[] {
  return steps.map((s) =>
    typeof s === "string"
      ? { instruction: s, optional: false, upload: false, origin: "original" }
      : {
          instruction: s.step,
          optional: s.optional,
          upload: s.upload,
          submitStep: s.submitStep,
          payloadField: s.payloadField,
          payloadFieldNone: s.payloadFieldNone,
          origin: "original",
        }
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
function denormalizeStep(step: NormalizedStep):
  | string
  | {
      step: string;
      optional?: true;
      upload?: true;
      submitStep?: true;
      payloadField?: string;
      payloadFieldNone?: true;
    } {
  const hasSplicerHint = step.payloadField !== undefined || step.payloadFieldNone === true;
  if (!step.optional && !step.upload && !step.submitStep && !hasSplicerHint) {
    return step.instruction;
  }
  const out: {
    step: string;
    optional?: true;
    upload?: true;
    submitStep?: true;
    payloadField?: string;
    payloadFieldNone?: true;
  } = {
    step: step.instruction,
  };
  if (step.optional) out.optional = true;
  if (step.upload) out.upload = true;
  if (step.submitStep) out.submitStep = true;
  if (step.payloadField !== undefined) out.payloadField = step.payloadField;
  if (step.payloadFieldNone === true) out.payloadFieldNone = true;
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
 * Resume-from-failure filter for replan output. The global replanner should emit
 * only a recovery BRIDGE from the failure point (the original remaining tail is
 * re-appended by the driver), but it sometimes re-emits already-completed steps
 * — re-filling name/email/etc. after a later step fails — which inflates the
 * plan and wastes wall-clock + replan budget re-doing done work. Drop any bridge
 * step whose instruction matches a completed step, EXCEPT a re-emission of the
 * failed step itself (a legitimate no-op bridge the replan prompt allows).
 */
export function filterCompletedFromReplan(
  newSteps: readonly NormalizedStep[],
  completedSteps: readonly string[],
  failedStep: string
): NormalizedStep[] {
  const completed = new Set(completedSteps);
  return newSteps.filter((s) => s.instruction === failedStep || !completed.has(s.instruction));
}

/** Whitespace/case-insensitive normalization for comparing step instructions. */
function normalizeInstruction(instruction: string): string {
  return instruction.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * Detect a replan that only re-proposes the step that JUST terminally failed —
 * i.e. after {@link filterCompletedFromReplan} the sole surviving bridge step is
 * byte-identical (whitespace/case-normalized) to the failed instruction. The
 * replan prompt allows a no-op re-emission of the failed step, but a bridge that
 * is NOTHING but the failed step is a guaranteed re-fail: resuming re-runs the
 * whole 5-attempt cascade on the exact click that just exhausted it (~1m40s
 * wasted) before the cycle detector — which needs REPLAN_CYCLE_THRESHOLD repeats
 * under a static page — even engages. This catches it on the FIRST occurrence.
 * Pure; returns false whenever the bridge adds any genuinely new step.
 */
export function isReplanReproposingFailedStep(
  newSteps: readonly NormalizedStep[],
  failedStep: string
): boolean {
  if (newSteps.length === 0) return false;
  const failedNorm = normalizeInstruction(failedStep);
  return newSteps.every((s) => normalizeInstruction(s.instruction) === failedNorm);
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
}): void {
  const {
    flowFile,
    finalPlan,
    replanEvents,
    logger,
    originalShape = "array",
    submitEndpointPattern = null,
    submittedStateSelectors = [],
    requireSubmitEndpointMatch = false,
    successUrlFragments = [],
    successPageTitleHints = [],
    ownBackendHostnames = [],
    knownErrorClassPrefixes = [],
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
          ...(requireSubmitEndpointMatch ? { requireSubmitEndpointMatch } : {}),
          ...(successUrlFragments.length > 0 ? { successUrlFragments } : {}),
          ...(successPageTitleHints.length > 0 ? { successPageTitleHints } : {}),
          ...(ownBackendHostnames.length > 0 ? { ownBackendHostnames } : {}),
          ...(knownErrorClassPrefixes.length > 0 ? { knownErrorClassPrefixes } : {}),
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

export function renderStepWindow(
  steps: readonly string[],
  options: { head?: number; tail?: number } = {}
): string {
  const { head = 0, tail = 10 } = options;
  if (steps.length === 0) return "(none)";
  const headSteps = head > 0 ? steps.slice(0, head) : [];
  const tailSteps = tail > 0 ? steps.slice(-tail) : [];
  const elided = steps.length - headSteps.length - tailSteps.length;
  const lines: string[] = [];
  for (const [i, s] of headSteps.entries()) {
    lines.push(`${i + 1}. ${s}`);
  }
  if (elided > 0) {
    lines.push(`... (${elided} steps elided for prompt budget) ...`);
  }
  const tailStart = steps.length - tailSteps.length + 1;
  for (const [i, s] of tailSteps.entries()) {
    lines.push(`${tailStart + i}. ${s}`);
  }
  return lines.join("\n");
}

/**
 * Detect a "false-premise loop" — the current cascade-exhausted step
 * shares a slug-prefix with at least N prior replans' failed steps,
 * suggesting the flow's element model for THIS widget family doesn't
 * match the actual DOM. Slug derivation mirrors the `currentPhase`
 * pattern at recon-browser.ts:5001 (24-char alphanumeric prefix of
 * normalized instruction). When the threshold is exceeded, callers
 * inject an ELEMENT MODEL CHECK section into the replan prompt so the
 * LLM is nudged to reconsider whether the failed-step's element
 * description matches anything on the page.
 *
 * Research grounding: Reflexion (Shinn et al., 2023) demonstrates +22%
 * improvement on AlfWorld via verbal-reinforcement feedback on prior
 * failures. Our existing replan prompt's PRIOR REPLAN HISTORY section
 * is Reflexion-style; this helper adds a quantified meta-signal when
 * the same element pattern fails N+ times in a row.
 */
export function countSlugPrefixMatches(
  currentFailedStep: string,
  priorReplans: readonly ReplanEvent[]
): number {
  const slugOf = (s: string): string =>
    s
      .replace(/[^a-z0-9]+/gi, "-")
      .toLowerCase()
      .replace(/^-|-$/g, "")
      .slice(0, 24);
  const currentSlug = slugOf(currentFailedStep);
  if (currentSlug.length === 0) return 0;
  let matches = 0;
  for (const ev of priorReplans) {
    if (slugOf(ev.failedInstruction) === currentSlug) matches++;
  }
  return matches;
}

async function readFailureDumpEvidence(
  failureDumpPath: string,
  options?: {
    client?: Anthropic | null;
    knownErrorClassPrefixes?: readonly string[];
    captureFn?: CaptureFn;
    /**
     * Live page from the running session. When provided, the deterministic
     * `:has()`-based leaf probe runs against the LIVE DOM (authoritative)
     * before falling back to the dump-based Haiku judge. Optional because
     * tests inject a dump path without a Playwright session; production
     * callers (replanRemainingFlow) always have `page` in scope and pass it.
     */
    page?: Page;
  }
): Promise<{
  bodyExcerpt: string;
  unfocusedList: string;
  invalidFieldList: string;
  errorTextList: string;
  recentFailureReasons: string[];
}> {
  try {
    const dump = JSON.parse(readFileSync(failureDumpPath, "utf8")) as {
      bodyOuterHtml?: string | null;
      unfocusedObserve?: Action[];
      attempts?: { errorMessage?: string | null }[];
    };
    const rawBody = dump.bodyOuterHtml;
    const bodyExcerpt = typeof rawBody === "string" ? selectBodyExcerpt(rawBody) : "";

    const client = options?.client ?? null;
    const knownErrorClassPrefixes = options?.knownErrorClassPrefixes ?? [];
    const captureFn = options?.captureFn;
    const page = options?.page;

    // Deterministic-first when the live page is available: probe the LIVE
    // DOM for leaf invalid containers via CSS `:has()`. Falls back to the
    // dump-based Haiku judge only when the live probe returns empty or
    // when no page is in scope (tests). See `probeLeafInvalidContainers`
    // docs for the rationale.
    const leafFields = page ? await probeLeafInvalidContainers(page) : [];

    const [unfocusedList, invalidVerdict, errorVerdict] = await Promise.all([
      renderUnfocusedObserve(dump.unfocusedObserve ?? [], { client, captureFn }),
      leafFields.length > 0
        ? Promise.resolve(null)
        : judgeInvalidFieldsWithLLM({
            client,
            input: { bodyHtmlExcerpt: bodyExcerpt, knownErrorClassPrefixes },
            captureFn,
          }),
      judgeErrorMessagesWithLLM({
        client,
        input: { bodyHtmlExcerpt: bodyExcerpt },
        captureFn,
      }),
    ]);

    const invalidFieldList =
      leafFields.length > 0
        ? renderLeafInvalidFields(leafFields)
        : (() => {
            const invalidLines =
              invalidVerdict?.fields.map((f) => {
                const label = f.label ?? "(unlabeled)";
                return `${label}  [${f.framework} ${f.markerKind}] ${f.containerXpath}`;
              }) ?? [];
            return invalidLines.map((e, i) => `${i + 1}. ${e}`).join("\n");
          })();

    const errorLines =
      errorVerdict?.messages.map((m) => {
        const field = m.fieldHint ? `[${m.fieldHint}] ` : "";
        return `${field}${m.severity}: ${m.text}`;
      }) ?? [];
    const errorTextList = errorLines.map((e, i) => `${i + 1}. ${e}`).join("\n");

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
  trajectory?: readonly { stepIndex: number; verifiedBy: AttemptRecord["verifiedBy"] }[];
  /**
   * Previous replans constructed for this run. Rendered into a PRIOR REPLAN
   * HISTORY section as graduated discouragement — re-proposing a sequence
   * that already failed is unlikely to converge, but is not forbidden because
   * intervening cascade steps may have advanced the page since the prior
   * attempt. The deterministic isReplanCycle predicate is the safety net.
   */
  priorReplans?: readonly ReplanEvent[];
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
    ownBackendHostnames = [],
    knownErrorClassPrefixes: replanKnownErrorClassPrefixes = [],
    trajectory = [],
    priorReplans = [],
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
  const priorReplanList =
    priorReplans.length > 0
      ? priorReplans
          .map(
            (ev) =>
              `replan #${ev.replanIndex} (failed on: ${ev.failedInstruction})\nproposed:\n${ev.replanSteps
                .map((s, i) => `  ${i + 1}. ${s.instruction}`)
                .join("\n")}`
          )
          .join("\n\n")
      : "";
  const candidates = await guardedObserve(
    stagehand,
    undefined,
    { timeout: STEP_WATCHDOG_MS },
    captureFn
  ).catch(() => [] as Action[]);
  const candidateList = await renderUnfocusedObserve(candidates, { client, captureFn });
  const pageTitle = await page.title().catch(() => "");

  // Without raw DOM in the prompt, the LLM only sees stagehand.observe()'s
  // filtered candidate list and hallucinates about surrounding state
  // (auth-wall reset, closed-message interstitial, etc.).
  const { bodyExcerpt, unfocusedList, invalidFieldList, errorTextList, recentFailureReasons } =
    await readFailureDumpEvidence(failureDumpPath, {
      client,
      knownErrorClassPrefixes: replanKnownErrorClassPrefixes,
      captureFn,
      page,
    });
  const failureReasonList = recentFailureReasons.map((r, i) => `${i + 1}. ${r}`).join("\n");
  const submitFailureList = extractSubmitFailureEvidence(recentCaptures, ownBackendHostnames);
  const gaEventList = extractGaEventEvidence(recentCaptures);

  // False-premise meta-signal: when 2+ prior replans failed on a step
  // sharing the same 24-char slug-prefix as the current failed step,
  // inject an ELEMENT MODEL CHECK section. Reflexion-grounded
  // (verbal-reinforcement on repeated failures); intended to break the
  // degenerate "Click Continue" / "Fill Address" loop the smoke run
  // showed when the cascade got anchored to a non-existent element
  // ("Click the Year spinbutton" steps targeting an HTML5 <input
  // type='date'>).
  const slugPriorMatches = countSlugPrefixMatches(failedStep, priorReplans);
  const elementModelCheck =
    slugPriorMatches >= 2
      ? `ELEMENT MODEL CHECK — The cascade has now failed ${slugPriorMatches + 1} times on steps matching the same element pattern. When the same element family fails repeatedly, the failed-step's element description may NOT match the actual DOM (e.g. the step asks for "spinbutton" but the page only has <input type="date">; asks for "Select dropdown" but the page has a custom autocomplete; asks for a "Click" target that's a label-only with no clickable child). Inspect PAGE BODY HTML AT FAILURE: if the actual widget in the DOM differs from the failed step's element description, propose a STRUCTURALLY DIFFERENT recovery that targets the actual widget visible on the page (e.g. "Fill in the date input field with today's date" instead of "Click the Month spinbutton") rather than restating the failed step's premise.`
      : "";

  // Structural-block meta-signal: when NO attempt ever resolved a selector for
  // the failed step (every attempt found nothing to act on), the step's target
  // widget/control was never present-and-drivable — rewording the same premise
  // will fail identically. Tell the LLM to change approach or mark impossible,
  // not paraphrase. Read the persisted attempt records from the failure dump.
  const structurallyBlocked = (() => {
    try {
      const dump = JSON.parse(readFileSync(failureDumpPath, "utf8")) as {
        attempts?: { triedSelectors?: string[]; verifiedBy?: string | null }[];
      };
      const attempts = (dump.attempts ?? []).map((a) => ({
        triedSelectors: a.triedSelectors ?? [],
        verifiedBy: a.verifiedBy ?? null,
      }));
      return isStructurallyBlocked(attempts);
    } catch {
      return false;
    }
  })();
  const structuralBlockCheck = structurallyBlocked
    ? `STRUCTURAL BLOCK — Every cascade attempt on the failed step resolved NO element (observe found no candidate; nothing was clicked or filled). The step's target is not present-and-drivable on this page as described. Do NOT merely reword or paraphrase the same premise — it will fail identically. Either (a) propose a STRUCTURALLY DIFFERENT step targeting a control that actually exists in PAGE BODY HTML AT FAILURE / the observed candidates, or (b) if the required control genuinely isn't reachable, return outcome=impossible rather than a cosmetic rewrite.`
    : "";

  const prompt = `You are helping a browser automation agent recover from a failed flow step.

ORIGINAL FLOW SUMMARY: ${originalFlow.length} total steps; ${completedSteps.length} executed, ${remainingSteps.length} remaining after the failed step. The completed-tail and remaining-head windows below give you the local context — that's the only flow context replan needs.

STEPS ALREADY COMPLETED (these succeeded — do NOT re-emit any of them; the head shows early fills like name/email so you don't repeat them):
${renderStepWindow(completedSteps, { head: 8, tail: 10 })}

THE STEP THAT JUST FAILED (after exhausting its per-step healing cascade):
${failedStep}

REMAINING UNEXECUTED STEPS (head of what comes after the failed step; the driver will auto-append the FULL remaining tail after your bridge so do not re-emit these):
${renderStepWindow(remainingSteps, { head: 15, tail: 0 })}

CURRENT BROWSER STATE:
URL: ${page.url()}
Title: ${pageTitle}

${elementModelCheck ? `${elementModelCheck}\n\n` : ""}${structuralBlockCheck ? `${structuralBlockCheck}\n\n` : ""}WHY VERIFICATION FAILED (latest attempt reasons from the cascade — read these carefully, they explain WHY the step is being declared failed):
${failureReasonList || "(none)"}

PAGE TRANSITION + VALIDATOR TELEMETRY (parsed from Google Analytics Measurement Protocol beacons (POSTs to google-analytics.com/g/collect) captured during the failed step's attempt window — this is the SPA's own telemetry telling you what state it thinks it's in. Watch for: en=view_secondPage / en=view_thirdPage indicating the SPA advanced to a later form page WITHOUT firing Page.frameNavigated (so URL stays the same but questions changed); en=view_thankYouPage indicating the application SUBMITTED SUCCESSFULLY (a stronger success signal than network captures because the /integrated_apply POST is sometimes debounced); epn.validationErrorsCount=N indicating the site's own client validator counts N unfilled required fields. When validationErrorsCount > 0, prefer steps that target unfilled fields over re-clicking Submit/Continue. When view_thankYouPage appears, the application already submitted — do not propose more form-fill steps):
${gaEventList || "(none)"}

FORM FIELDS CURRENTLY MARKED INVALID (text + class signature for any element whose class matches the framework-agnostic invalid pattern — ng-invalid, mat-form-field-invalid, is-invalid, etc.):
${invalidFieldList || "(none)"}

VISIBLE ERROR / REQUIRED-FIELD MESSAGES ON THE PAGE (extracted text from error-class containers — error-message, mat-error, field-error, validation-error, invalid-feedback, etc.):
${errorTextList || "(none)"}

STRUCTURED SERVER-SIDE VALIDATION ERRORS (parsed from captured 4xx responses to the submit endpoint — when populated, the form's submit DID fire and the server rejected it with specific feedback):
${submitFailureList || "(none)"}

PRIOR REPLAN HISTORY (proposals from previous replans for this same failure; the cascade executed each one and verification still failed at the time it ran. Between replans, the page may have advanced — a step that failed earlier could potentially work now if intervening steps filled missing prerequisites or dismissed blockers. But re-proposing the EXACT same multi-step sequence that already failed is unlikely to produce a different outcome. Prefer structurally different recovery paths. If you re-use a prior step, pair it with new context that addresses why it failed before):
${priorReplanList || "(none)"}

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
    logBillingErrorIfPresent(err);
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

const DEFAULT_RESUME_FIXTURE_PATH = "src/testing/fixtures/resume.pdf";

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
  requireSubmitEndpointMatch: boolean;
  advanceTransitionBodyPattern: string | null;
  successUrlFragments: string[];
  successPageTitleHints: string[];
  ownBackendHostnames: string[];
  knownErrorClassPrefixes: string[];
  wizardExitButtonLabels: string[];
  restartSignalUrlPatterns: string[];
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
      requireSubmitEndpointMatch: false,
      advanceTransitionBodyPattern: null,
      successUrlFragments: [],
      successPageTitleHints: [],
      ownBackendHostnames: [],
      knownErrorClassPrefixes: [],
      wizardExitButtonLabels: [],
      restartSignalUrlPatterns: [],
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
  const requireSubmitEndpointMatch = Array.isArray(parsed.data)
    ? false
    : (parsed.data.requireSubmitEndpointMatch ?? false);
  const advanceTransitionBodyPattern = Array.isArray(parsed.data)
    ? null
    : (parsed.data.advanceTransitionBodyPattern ?? null);
  const successUrlFragments = Array.isArray(parsed.data)
    ? []
    : (parsed.data.successUrlFragments ?? []);
  const successPageTitleHints = Array.isArray(parsed.data)
    ? []
    : (parsed.data.successPageTitleHints ?? []);
  const ownBackendHostnames = Array.isArray(parsed.data)
    ? []
    : (parsed.data.ownBackendHostnames ?? []);
  const knownErrorClassPrefixes = Array.isArray(parsed.data)
    ? []
    : (parsed.data.knownErrorClassPrefixes ?? []);
  const wizardExitButtonLabels = Array.isArray(parsed.data)
    ? []
    : (parsed.data.wizardExitButtonLabels ?? []);
  const restartSignalUrlPatterns = Array.isArray(parsed.data)
    ? []
    : (parsed.data.restartSignalUrlPatterns ?? []);
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
    requireSubmitEndpointMatch,
    advanceTransitionBodyPattern,
    successUrlFragments,
    successPageTitleHints,
    ownBackendHostnames,
    knownErrorClassPrefixes,
    wizardExitButtonLabels,
    restartSignalUrlPatterns,
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
    requireSubmitEndpointMatch,
    advanceTransitionBodyPattern,
    successUrlFragments,
    successPageTitleHints,
    ownBackendHostnames,
    knownErrorClassPrefixes,
    wizardExitButtonLabels,
    restartSignalUrlPatterns,
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
  mkdirSync(COOKIES_DIR, { recursive: true });
  const resumeFixture = loadResumeFixture(resumeFixturePath);
  // Per-URL partition under the flow file's site directory. Without a flow
  // file (inline --flow mode), telemetry has no durable home and is dropped
  // — captureFn becomes a no-op so dev one-offs don't crash and don't
  // pollute the global sink.
  const siteTelemetryDir = resolveSiteTelemetryDir(flowFile);
  // Capture the run-start timestamp once so the calls.ndjson and url.txt
  // sidecar resolve to the same directory.
  const runTimestampMs = Date.now();
  const callsNdjsonPath =
    siteTelemetryDir !== null ? resolveRunCallsPath(siteTelemetryDir, runTimestampMs, url) : null;
  if (siteTelemetryDir !== null && callsNdjsonPath !== null) {
    mkdirSync(dirname(callsNdjsonPath), { recursive: true });
    writeFileSync(resolveRunUrlPath(siteTelemetryDir, runTimestampMs, url), `${url}\n`);
    logger.info(`telemetry: per-URL partition at ${callsNdjsonPath}`);
  } else {
    logger.info("telemetry: no flow file path — call capture disabled for this run");
  }
  const captureFn: CaptureFn =
    callsNdjsonPath !== null
      ? (input) => captureLlmCall(input, { sinkPath: callsNdjsonPath })
      : async () => {};
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
  // Indexes cookie-jar snapshot filenames chronologically, separate from
  // `counter` (network captures) so a phase with zero network activity still
  // gets a snapshot without skipping capture indices.
  const jarCounter = { n: 0 };
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

    logger.info(`navigating to ${url} (waitUntil: ${GOTO_WAIT_UNTIL})`);
    // A navigation wait that never resolves must not discard the run. Ad-heavy
    // commercial sites (analytics/session-replay beacons on timers) never reach
    // `networkidle`, so the wait burns GOTO_TIMEOUT_MS and throws — after the
    // captures we came for are already on disk. Warn and press on: readiness is
    // established by the SPA probe below, and the flow steps fail loudly on
    // their own if the page really is unusable.
    try {
      await page.goto(url, { waitUntil: GOTO_WAIT_UNTIL, timeoutMs: GOTO_TIMEOUT_MS });
    } catch (err) {
      logger.warn(
        `navigation wait (${GOTO_WAIT_UNTIL}) did not settle: ${toErrorMessage(err)} — continuing; the SPA readiness probe below decides whether the page is usable`
      );
    }
    await snapshotAndPersistCookieJar(page, jarCounter, "goto", currentPhase, -1);

    const SPA_READINESS_TIMEOUT_MS = 15_000;
    const SPA_READINESS_POLL_MS = 500;
    const SPA_MIN_BODY_LENGTH = 5_000;
    const spaDeadline = Date.now() + SPA_READINESS_TIMEOUT_MS;
    let bodyLength = await page
      .evaluate("document.body ? document.body.outerHTML.length : 0")
      .catch(() => 0);
    if (typeof bodyLength === "number" && bodyLength < SPA_MIN_BODY_LENGTH) {
      logger.info(
        `spa readiness: body ${bodyLength} chars < ${SPA_MIN_BODY_LENGTH} threshold — waiting for SPA to render`
      );
      while (Date.now() < spaDeadline) {
        await new Promise((r) => setTimeout(r, SPA_READINESS_POLL_MS));
        bodyLength = await page
          .evaluate("document.body ? document.body.outerHTML.length : 0")
          .catch(() => 0);
        if (typeof bodyLength === "number" && bodyLength >= SPA_MIN_BODY_LENGTH) {
          logger.info(`spa readiness: body grew to ${bodyLength} chars — SPA rendered`);
          break;
        }
      }
      if (typeof bodyLength === "number" && bodyLength < SPA_MIN_BODY_LENGTH) {
        logger.warn(
          `spa readiness: body still ${bodyLength} chars after ${SPA_READINESS_TIMEOUT_MS}ms — proceeding with possibly incomplete page`
        );
      }
    }

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

    const STUCK_SKIP_THRESHOLD = 5;
    let consecutiveStaleSkips = 0;
    let lastSuccessNetworkCount = signalCounter.n;
    let lastSuccessUrl = page.url();
    // Track the page origin so a cross-origin navigation mid-flow (e.g. the
    // Apply click taking careers.hcahealthcare.com → apply.talemetry.com) can
    // re-gate on SPA hydration. The initial goto's readiness gate only covers
    // the landing page; the wizard app boots on a DIFFERENT origin with no gate,
    // so its first steps would otherwise probe an un-hydrated shell and skip.
    const originOf = (u: string): string => {
      try {
        return new URL(u).origin;
      } catch {
        return "";
      }
    };
    let lastOrigin = originOf(page.url());

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
      await snapshotAndPersistCookieJar(page, jarCounter, "pre-step", currentPhase, i);
      // Re-gate on SPA hydration when the origin changed since the last step —
      // the wizard SPA (e.g. apply.talemetry.com after the Apply click) boots on
      // a new origin the initial-goto readiness gate never covered, so wait for
      // its body to render before probing rather than skipping a shell page.
      const currentOrigin = originOf(page.url());
      if (currentOrigin !== "" && currentOrigin !== lastOrigin) {
        logger.info(
          `origin changed ${lastOrigin || "(none)"} → ${currentOrigin}; re-gating on SPA hydration`
        );
        await waitForSpaReady(page, logger);
        lastOrigin = currentOrigin;
      }
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
      // Baseline for wizard-restart detection: capture the highest capture
      // INDEX before the step so findWizardRestartSignal scans only URLs that
      // landed during THIS step's processing (eviction-proof disk scan).
      const preCaptureIdxBeforeStep = latestCaptureIndex(recentCaptures);
      try {
        const stepOutcome = await executeStepWithHealing({
          stagehand,
          page,
          step: step.instruction,
          optional: step.optional,
          upload: step.upload,
          submitStep: step.submitStep === true,
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
          requireSubmitEndpointMatch,
          advanceTransitionBodyPattern,
          successUrlFragments,
          successPageTitleHints,
          ownBackendHostnames,
          knownErrorClassPrefixes,
          wizardExitButtonLabels,
          trajectory,
          captureFn,
          onStepFailure: dumpStepFailure,
        });
        await snapshotAndPersistCookieJar(page, jarCounter, "post-step", currentPhase, i);

        // Wizard-restart detection: if a configured restart-signal URL (e.g.
        // Talemetry's `init-apply?...&application_canceled=true`) landed during
        // this step, the multi-page wizard reset to page 1. Remaining steps now
        // target a reset page and replanning against the restarted wizard is
        // futile — abort with a diagnostic instead of silently cycling.
        const restartUrl = findWizardRestartSignal({
          preIdx: preCaptureIdxBeforeStep,
          restartSignalUrlPatterns,
        });
        if (restartUrl !== null) {
          throw new StepVerificationError(
            `step ${i + 1} (${step.instruction.slice(0, 60)}) triggered a wizard restart (${restartUrl.slice(0, 120)}) — the application reset to the first page; aborting`,
            "wizard-regression"
          );
        }

        if (stepOutcome === "skipped") {
          const pageStagnant =
            signalCounter.n === lastSuccessNetworkCount && page.url() === lastSuccessUrl;
          if (pageStagnant) {
            consecutiveStaleSkips++;
          }
          if (consecutiveStaleSkips >= STUCK_SKIP_THRESHOLD) {
            logger.warn(
              `stuck detection: ${consecutiveStaleSkips} consecutive optional steps skipped with no page advancement (url=${lastSuccessUrl}, networkCount=${lastSuccessNetworkCount}) — treating as probe-absent failure to trigger replan`
            );
            consecutiveStaleSkips = 0;
            throw new StepVerificationError(
              `step ${i + 1} (${step.instruction.slice(0, 60)}) stuck: ${STUCK_SKIP_THRESHOLD}+ consecutive optional skips with stagnant page`,
              "probe-absent"
            );
          }
        } else {
          consecutiveStaleSkips = 0;
          lastSuccessNetworkCount = signalCounter.n;
          lastSuccessUrl = page.url();
        }

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
        if (err.kind === "wizard-regression") {
          // The wizard restarted; replanning against a reset page cannot recover
          // the lost progress. Bypass the replan dispatcher and abort.
          logger.error(`wizard regression: ${err.message}; aborting run`);
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
        //
        // When the flow declares submitEndpointPattern, the "recent 2xx" must
        // match it. Without this gate, the heuristic latches onto every
        // non-GET 2xx — including pre-submit interruption_check POSTs and
        // third-party analytics tracking pixels (Google Analytics, DoubleClick,
        // googletagmanager) that fire on form interaction events. Those look
        // exactly like real submissions by HTTP signal but don't represent the
        // actual application landing. Verified by reading captures from
        // /tmp/recon/graphql/ during a sweep: Presbyterian jobs hit this exact
        // failure — only interruption_check + GA tracking POSTs fired, no
        // integrated_apply, yet trailing-grace declared success.
        if (step.optional && i >= plan.length - TRAILING_GRACE_WINDOW) {
          // Trailing-grace check: did the submit actually land somewhere in
          // the recent capture history? Ask the same Haiku judge — it has
          // multi-signal reasoning to distinguish real submit POSTs from
          // analytics/tracking 2xx that look submission-shaped.
          const pageTitle = await page.title().catch(() => "");
          const trailingGraceVerdict = await verifySubmitWithLLM({
            client: anthropic,
            input: {
              pageUrl: page.url(),
              pageTitle,
              unfocusedObserve: [],
              networkCaptures: recentCaptureMeta,
              invalidMarkerCount: 0,
              ownBackendHostnames,
              successUrlFragments,
              successPageTitleHints,
              submittedStateSelectors,
            },
            captureFn,
          });
          if (trailingGraceVerdict?.verified) {
            logger.info(
              `step ${i + 1} optional + trailing position; judge verified recent submit (${trailingGraceVerdict.rationale}) — treating verification failure as benign no-op; recon complete`
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
          const kindsSummary =
            callsNdjsonPath !== null
              ? summarizeReplanFailureKinds({
                  callsNdjsonPath,
                  callType: CALL_TYPE_RECON_REPLAN,
                  tailCount: budget * 2,
                })
              : "";
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

        const rawNewSteps = await replanRemainingFlow({
          client: anthropic,
          originalFlow: flow.map((s) => s.instruction),
          completedSteps,
          failedStep: step.instruction,
          remainingSteps: originalRemaining.map((s) => s.instruction),
          failureDumpPath: dumpPath,
          page,
          stagehand,
          captureFn,
          recentCaptures,
          ownBackendHostnames,
          trajectory,
          priorReplans: replanEvents,
        });

        if (!rawNewSteps) {
          logger.error(
            `replan #${replanIndex} returned outcome=impossible or unparseable output; aborting`
          );
          throw err;
        }

        // Resume-from-failure: drop any replan bridge step that re-runs an
        // already-completed step (see filterCompletedFromReplan). Keeps the
        // failed step's re-emission. originalRemaining is re-appended below.
        const newSteps = filterCompletedFromReplan(rawNewSteps, completedSteps, step.instruction);
        const droppedCompleted = rawNewSteps.length - newSteps.length;
        if (droppedCompleted > 0) {
          logger.info(
            `replan #${replanIndex}: dropped ${droppedCompleted} bridge step(s) that re-ran already-completed steps`
          );
        }
        if (newSteps.length === 0) {
          logger.error(
            `replan #${replanIndex} produced only already-completed steps (nothing new to bridge); aborting`
          );
          throw err;
        }

        // Immediate no-progress guard: if the replan's only bridge is a
        // re-emission of the step that just failed, resuming re-runs the whole
        // cascade on the identical click that just exhausted it. Abort now
        // instead of waiting REPLAN_CYCLE_THRESHOLD repeats for the cycle
        // detector — that many dead cascades cost minutes of wall-clock.
        if (isReplanReproposingFailedStep(newSteps, step.instruction)) {
          const noProgressMessage = `replan #${replanIndex} re-proposed only the just-failed step ("${step.instruction.slice(0, 60)}") with no new bridge; resuming would re-fail identically — aborting`;
          logger.error(noProgressMessage);
          throw new StepVerificationError(noProgressMessage, "replan-cycle-detected");
        }

        const currentPageState = await snapshotPage(page, signalCounter).catch(() => ({
          url: page.url(),
          bodyHtmlLength: 0,
        }));
        if (
          isReplanCycle(replanEvents, newSteps, {
            url: currentPageState.url,
            htmlLength: currentPageState.bodyHtmlLength,
          })
        ) {
          const cycleMessage = `replan cycle detected: identical proposal × ${REPLAN_CYCLE_THRESHOLD} under static page state; aborting`;
          logger.error(cycleMessage);
          throw new StepVerificationError(cycleMessage, "replan-cycle-detected");
        }

        if (isProbe) {
          probeReplansUsed++;
        } else {
          cascadeReplansUsed++;
        }
        // err.kind narrowed to the two replan-bearing variants here: the
        // backend-error-unrecoverable dispatcher above throws out, and the
        // cycle-detected variant is only constructed at the throw site just
        // above this push — never caught back here.
        replanEvents.push({
          replanIndex,
          cause: err.kind as "probe-absent" | "cascade-exhausted",
          indexAtFailure: i,
          failedInstruction: step.instruction,
          replanSteps: newSteps,
          timestamp: formatISO(new Date()),
          pageState: {
            url: currentPageState.url,
            htmlLength: currentPageState.bodyHtmlLength,
          },
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

    // End-of-run audit: when the flow declared submitEndpointPattern AND
    // opted into requireSubmitEndpointMatch=true, scan ALL captures from
    // this run for a pattern-matching 200 before declaring success. If no
    // match, the run "succeeded" by the verifier's lights but the actual
    // submission didn't land. Exit non-zero so the caller (test harness,
    // CI, or production runner) can distinguish silent-pass from real
    // success. This closes the loop the silent-pass bug exposed on 2026-
    // 06-09: per-step verifier accepted DOM-fallback as proof; run-level
    // audit catches that the network proof never actually arrived.
    if (requireSubmitEndpointMatch && ownBackendHostnames.length > 0) {
      const { auditFailed, rejectionReason } = auditFinalSubmitMatch({
        ownBackendHostnames,
        capturesDir: CAPTURES_DIR,
        logger,
      });
      if (auditFailed) {
        const reasonSuffix = rejectionReason
          ? ` — server REJECTED submission with rejection envelope (reason: "${rejectionReason}"); HTTP layer succeeded but application was not accepted`
          : ` — no captured 2xx had hostname in ${JSON.stringify(ownBackendHostnames)} — submission did not land despite verifier success`;
        logger.error(`end-of-run audit FAILED${reasonSuffix}`);
        // Exit non-zero so the runner counts this as a real failure rather
        // than rolling silent-pass forward as success.
        process.exit(1);
      }
      logger.info(
        `end-of-run audit PASSED: at least one captured 2xx matched submitEndpointPattern with clean response body`
      );
    }

    await snapshotAndPersistCookieJar(
      page,
      jarCounter,
      "run-complete",
      currentPhase,
      plan.length - 1
    );

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
            requireSubmitEndpointMatch,
            successUrlFragments,
            successPageTitleHints,
            ownBackendHostnames,
            knownErrorClassPrefixes,
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

export type {
  Html5DateFillResult,
  InvalidFormControl,
  LeafInvalidField,
  RadioGroupCandidate,
  ValidationRejectionPair,
  VerifyFillReadbackResult,
} from "@/scraper/flow-runner";
// Re-export shim: the step-execution engine now lives in `@/scraper/flow-runner`
// (extracted from this module). Recon's tests and any downstream importer keep
// importing these symbols from `@/scripts/recon-browser` unchanged.
export {
  buildRadioIdXPath,
  capturesAfterIndex,
  chooseRequiredSelectOption,
  describeAttemptEffectSignals,
  extractGaEventEvidence,
  extractSubmitFailureEvidence,
  fillHtml5DateTimeInput,
  findRecentBackendError,
  findRecentPageTransition,
  formatValidationRejectedReason,
  hasBillingErrorBeenLogged,
  isAdvanceStalled,
  isAdvanceStep,
  isDomOnlyAdvanceVerified,
  isSubmitRevealedInvalid,
  isUploadAffordanceLabel,
  isWizardExitAction,
  latestCaptureIndex,
  logBillingErrorIfPresent,
  narrowInvalidFormControl,
  normalizeDateValue,
  pairInvalidWithErrors,
  parseCaptureIndex,
  parseRadioStep,
  parseSelectStep,
  pollEnumerate,
  probeLeafInvalidContainers,
  probeStepBeforeAttempts,
  renderLeafInvalidFields,
  renderUnfocusedObserve,
  rephraseWithLLM,
  resetBillingErrorFlagForTests,
  selectBodyExcerpt,
  selectRadioGroupOption,
  shouldSkipTechnique,
  shouldVetoFallbackAdvance,
  verifyFillReadback,
  waitForTransitionBody,
  windowHasAdvanceTransition,
  windowHasTransitionBody,
  writeFixtureToTempFile,
} from "@/scraper/flow-runner";
export type { NormalizedStep, ReplanEvent };
// Test-only exports — allow unit tests to inject a fake capture sink without
// touching the main() entry-point or the real browser session.
export {
  dedupeConsecutiveIdentical,
  denormalizeStep,
  persistReplannedFlow,
  readFailureDumpEvidence,
  replanRemainingFlow,
  snapshotAndPersistCookieJar,
};
