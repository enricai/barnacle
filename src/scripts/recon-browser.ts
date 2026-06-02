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
 *   # Capture every network response (useful for non-GraphQL/REST sites):
 *   pnpm tsx src/scripts/recon-browser.ts --url https://example.com --capture-all
 *
 *   # Capture page-load XHRs only (no interaction — pure GET-style SPAs):
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
import { z } from "zod/v4";

import { config } from "@/config";
import { toErrorMessage } from "@/lib/errors";
import { configureHttpDispatcher } from "@/lib/http";
import { getScriptLogger } from "@/lib/logging";
import { captureLlmCall, type LlmCallInput } from "@/lib/telemetry/call-capture";
import { CALL_TYPE_RECON_REPHRASE, CALL_TYPE_RECON_REPLAN } from "@/lib/telemetry/call-types";
import { StepVerificationError } from "@/scraper/errors";
import { createBrowserSession, type ProviderName } from "@/scraper/session";
import { CAPTURES_DIR, type Capture, STEP_FAILURES_DIR } from "@/scripts/recon-shared";
import type { Logger } from "@/types/logging";

configureHttpDispatcher();

const logger = getScriptLogger("recon-browser");

/** Navigation timeout for page.goto — raise for slow tunnels or proxied targets. */
const GOTO_TIMEOUT_MS = 120_000;
/** Post-action pause between flow steps — gives the page time to settle. */
const STEP_PAUSE_MS = 2_000;

/**
 * URL patterns we care about — GraphQL, REST API paths, and static JSON.
 * Intentionally conservative: add `--capture-all` for sites whose API paths
 * don't match these patterns (e.g. `/catalog`, `/products` without `/api/`).
 */
const CAPTURE_PATTERNS = [/\/graph/, /\/api\//, /\/graphql/, /\/v1\//, /\.json(\?|$)/];

/**
 * URLs that look like background polling. Captures still get written to disk
 * (we want the evidence), but they don't increment the verifier's network
 * counter — otherwise SPAs that poll for async state ('did the resume parse
 * yet?', 'is payment processed?') make every action look "verified" because
 * a coincident poll happened to fire. Patterns target the *shape* of polling
 * URLs (suffixes, cache-busters) not specific site paths.
 *
 * The `_=\d{10,}` rule catches jQuery's default cache-buster — added on GETs
 * that need to bypass browser caches, which in practice is overwhelmingly
 * polling or retried pre-fetches. Real form-submitting POSTs don't carry it.
 */
const POLLING_URL_PATTERNS = [
  /\/check(\?|$|\/)/,
  /\/poll(\?|$|\/)/,
  /\/status(\?|$|\/)/,
  /\/ping(\?|$|\/)/,
  /\/heartbeat(\?|$|\/)/,
  /[?&]_=\d{10,}/,
];

function shouldCapture(url: string, captureAll: boolean): boolean {
  if (captureAll) return true;
  return CAPTURE_PATTERNS.some((p) => p.test(url));
}

/**
 * True when the captured URL looks like a background poll. The verifier
 * excludes these from its network-delta signal — see POLLING_URL_PATTERNS.
 */
function isBackgroundPoll(url: string): boolean {
  return POLLING_URL_PATTERNS.some((p) => p.test(url));
}

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
  captureAll: boolean,
  counter: { n: number },
  signalCounter: { n: number },
  recentCaptures: string[],
  getCurrentPhase: () => string
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
    if (!shouldCapture(params.request.url, captureAll)) return;
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
    // The verifier reads signalCounter (not counter) so a background poll
    // doesn't poison its "did anything happen" signal. Filename indexing
    // stays on counter so polls still get unique filenames on disk.
    if (!isBackgroundPoll(req.url)) {
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
const MAX_STEP_ATTEMPTS = 4;
/** Per-attempt linear backoff base; sleep = attempt * BACKOFF_MS. */
const ATTEMPT_BACKOFF_MS = 1_000;
/**
 * Max global replans per recon run. Each replan asks Claude to rewrite the
 * remaining tail of the flow when a step terminally fails. Two is enough
 * room to recover from one unexpected UI shift without burning budget on a
 * fundamentally unsolvable flow.
 */
const MAX_REPLANS = 2;
/** Guardrail on the size of an LLM-produced revised flow tail. */
const REPLAN_MAX_STEPS = 20;

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
  technique: "act-string" | "observe-act" | "observe-act-exclude" | "llm-rephrase";
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
  /** Which verification signal carried the attempt: `network`, `url`, `dom`, or null on failure. */
  verifiedBy: "network" | "url" | "dom" | null;
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
  captureFn: CaptureFn = captureLlmCall
): Promise<string | null> {
  const candidateList = observeCandidates
    .slice(0, 12)
    .map((a, i) => `${i + 1}. ${a.description} — ${a.selector}`)
    .join("\n");
  const triedList = triedSelectors.length > 0 ? triedSelectors.join("\n") : "(none)";
  const reasonList = failureReasons.map((r, i) => `attempt ${i + 1}: ${r}`).join("\n");

  const prompt = `You are helping a browser automation agent recover from a failed step in a recon flow.

ORIGINAL INSTRUCTION:
${originalStep}

WHY EARLIER ATTEMPTS FAILED:
${reasonList}

SELECTORS ALREADY TRIED (avoid these):
${triedList}

ELEMENTS CURRENTLY VISIBLE ON THE PAGE:
${candidateList || "(no candidates returned by observe)"}

Rewrite the instruction so a Stagehand act() call can resolve it unambiguously to a different element than the ones already tried. Keep it short — one sentence, natural language, no quotes around it. If the original instruction is itself impossible on the current page (the element does not exist), reply with the literal string IMPOSSIBLE so the caller can stop trying.`;

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
    });

    if (!parsedOk) return null;
    return text;
  } catch {
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
    });
    return null;
  }
}

/**
 * Replanner response shape. Sent to Anthropic via `zodOutputFormat` so the API
 * enforces the schema and rejects malformed output (no prose preambles, no
 * markdown code fences, no schema-violating shapes). We accept either a
 * replanned step array or an explicit "impossible" outcome — the latter is
 * the structured replacement for the old IMPOSSIBLE magic string.
 */
const REPLAN_RESPONSE_SCHEMA = z.discriminatedUnion("outcome", [
  z.object({
    outcome: z.literal("replan"),
    steps: z.array(z.string().min(1)).min(1).max(REPLAN_MAX_STEPS),
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
function readFailureDumpEvidence(failureDumpPath: string): {
  bodyExcerpt: string;
  unfocusedList: string;
} {
  try {
    const dump = JSON.parse(readFileSync(failureDumpPath, "utf8")) as {
      bodyOuterHtml?: string | null;
      unfocusedObserve?: Action[];
    };
    const rawBody = dump.bodyOuterHtml;
    const bodyExcerpt = typeof rawBody === "string" ? rawBody.slice(0, 8000) : "";
    const unfocusedList = (dump.unfocusedObserve ?? [])
      .slice(0, 12)
      .map((a, i) => `${i + 1}. ${a.description} — ${a.selector}`)
      .join("\n");
    return { bodyExcerpt, unfocusedList };
  } catch {
    // Swallowed by design: a missing dump must not fail the replan.
    return { bodyExcerpt: "", unfocusedList: "" };
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
}): Promise<string[] | null> {
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
  } = params;
  const candidates = await stagehand.observe().catch(() => [] as Action[]);
  const candidateList = candidates
    .slice(0, 12)
    .map((a, i) => `${i + 1}. ${a.description} — ${a.selector}`)
    .join("\n");
  const pageTitle = await page.title().catch(() => "");

  // Without raw DOM in the prompt, the LLM only sees stagehand.observe()'s
  // filtered candidate list and hallucinates about surrounding state
  // (auth-wall reset, closed-message interstitial, etc.).
  const { bodyExcerpt, unfocusedList } = readFailureDumpEvidence(failureDumpPath);

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

ELEMENTS CURRENTLY VISIBLE ON THE PAGE (stagehand.observe with the failed instruction):
${candidateList || "(no candidates returned by observe)"}

UNFOCUSED OBSERVE (what Stagehand sees on the page without any instruction filter):
${unfocusedList || "(none)"}

PAGE BODY HTML AT FAILURE (truncated to 8KB — use this to detect interstitials, error messages, auth walls, or unexpected page states that the observe lists miss):
${bodyExcerpt || "(missing)"}

DIAGNOSTIC DUMP FILE (for reference):
${failureDumpPath}

Rewrite the remaining flow so the agent can reach the user's original intent from where it is now. You may:
- reorder remaining steps
- insert new steps (e.g. an "open the section first" prerequisite the original flow missed)
- drop redundant steps
- rephrase steps to be unambiguous given the current page state

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
- Do NOT include the already-completed steps in your output — only the new remaining tail to execute from here.
- If you can recover the flow, return outcome="replan" with the steps array.
- If the user's intent is unreachable from this page state, return outcome="impossible" with a brief reason.
- Maximum ${REPLAN_MAX_STEPS} steps.
- Each step is a single DOM action (see CRITICAL section above).`;

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
    });

    if (parsed.outcome === "replan") return parsed.steps;
    return null;
  } catch {
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

/**
 * Recognizes flow-step instructions that ask the agent to upload a resume
 * (PDF or generic). Site-agnostic: matches the natural-language intent users
 * naturally write into recon-flow.json files. Variations covered include
 * "upload the test resume PDF", "Upload the resume file", "attach a resume",
 * "upload your CV as a PDF", etc.
 *
 * Used by `tryUploadPrimitive` to decide whether to bypass the LLM cascade
 * and go straight to a `Locator.setInputFiles({ buffer })` call.
 */
const UPLOAD_RESUME_PATTERN =
  /\b(upload|attach)\b[^.]*\b(resume|cv)\b|\b(resume|cv)\b[^.]*\b(upload|attach)\b/i;

/**
 * Site-agnostic file-upload primitive that bypasses Stagehand's click-and-act
 * cascade for resume-style upload steps.
 *
 * Why this exists: many ATS upload widgets wrap the real `<input type="file">`
 * behind a styled button or dropdown menu (jQuery File Upload + Bootstrap,
 * Material UI menus, custom React popovers). Stagehand's CDP click often
 * fails to trigger the JS handlers that reveal the hidden file input — the
 * verifier correctly reports the click had no observable effect, but no
 * amount of replanning resolves it because no clickable path actually
 * surfaces the input.
 *
 * Strategy: when the flow-step instruction matches the resume-upload
 * pattern, observe for any `<input type="file">` on the page (Stagehand's
 * accessibility tree won't show it if the site hides it via CSS, but the
 * raw DOM does). If found, call `Locator.setInputFiles({ buffer })` with
 * the cached fixture buffer. This dispatches via Stagehand's payload-
 * injection path (active on Browserbase sessions), so no host-filesystem
 * access is required.
 *
 * Returns `true` if the upload completed; `false` if either the step
 * doesn't match the resume-upload pattern OR no file input was found
 * (caller falls through to the existing cascade in that case).
 */
async function tryUploadPrimitive(params: {
  page: Page;
  step: string;
  fixture: { buffer: Buffer; name: string; mimeType: string } | null;
  logger: Logger;
}): Promise<boolean> {
  const { page, step, fixture, logger } = params;
  if (!fixture) {
    return false;
  }
  if (!UPLOAD_RESUME_PATTERN.test(step)) {
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
  // Verify via DOM check that the file actually attached, not just that the
  // API call returned cleanly. Stagehand has been observed to return success
  // on attach calls that produced no DOM mutation (e.g. when env=LOCAL on a
  // remote browser); this confirms before we declare victory.
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
    logger.warn("upload primitive: setInputFiles returned but no file attached in DOM");
    return false;
  }
  logger.info(
    `upload primitive: attached fixture (name=${fixture.name}, size=${fixture.buffer.length}b, filesLength=${attachedLength})`
  );
  return true;
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
  if (!selector || !method) {
    return false;
  }
  try {
    const locator = page.locator(selector).first();
    switch (method) {
      case "fill":
      case "type": {
        const expected = action.arguments?.[0];
        if (typeof expected !== "string" || expected.length === 0) {
          return false;
        }
        const current = await locator.inputValue();
        return current.includes(expected);
      }
      case "check": {
        return await locator.isChecked();
      }
      case "uncheck": {
        return !(await locator.isChecked());
      }
      case "selectOption":
      case "selectOptionFromDropdown": {
        // Stagehand dispatches both names to Playwright's selectOption(text),
        // which only succeeds on native <select> and matches against any of
        // the option's value/label/textContent. Mirror that resolution here
        // so the verifier succeeds iff Playwright's "selection happened" is
        // true — same equality semantics, just read from the other side.
        const expected = action.arguments?.[0]?.toString().trim() ?? "";
        if (!expected) return false;
        const xpath = xpathBody(selector);
        if (!xpath) {
          // Non-xpath selector: can't compose the page.evaluate; fall back
          // to a weaker non-empty inputValue check.
          const current = await locator.inputValue().catch(() => "");
          return current.length > 0;
        }
        // Trust boundary: xpath comes from Stagehand's resolved selector
        // (not URL/user input). JSON.stringify produces a safe JS string
        // literal even for xpath containing quotes/backslashes, so composing
        // this expression cannot inject behavior through the xpath content.
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
        const matches = (field: string): boolean =>
          field.length > 0 && field.toLowerCase().includes(want);
        return matches(selected.value) || matches(selected.label) || matches(selected.text);
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
        if (!xpath) {
          return false;
        }
        let inputType: string | null = null;
        try {
          // Trust boundary: xpath comes from Stagehand's own resolved selector
          // (not URL/user input). JSON.stringify produces a safe JS string
          // literal even for content with quotes/backslashes, so composing
          // this expression cannot exfiltrate or inject behavior through the
          // xpath content alone. We use a string expression rather than a
          // function so Node-side typechecking doesn't choke on the browser
          // globals `document`/`XPathResult`.
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
        return await locator.isChecked();
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
async function executeStepWithHealing(params: {
  stagehand: Stagehand;
  page: Page;
  step: string;
  stepIndex: number;
  phase: string;
  signalCounter: { n: number };
  recentCaptures: string[];
  anthropic: Anthropic | null;
  logger: Logger;
  captureFn?: CaptureFn;
  resumeFixture: { buffer: Buffer; name: string; mimeType: string } | null;
}): Promise<void> {
  const {
    stagehand,
    page,
    step,
    stepIndex,
    phase,
    signalCounter,
    recentCaptures,
    anthropic,
    logger,
    captureFn,
    resumeFixture,
  } = params;
  const attempts: AttemptRecord[] = [];
  const triedSelectors: string[] = [];
  const failureReasons: string[] = [];

  // Try the site-agnostic upload primitive first. If it triggers and succeeds,
  // the step is fully handled — no cascade needed. If it returns false (step
  // didn't match the pattern, or no file input on the page), we fall through
  // to the existing cascade unchanged.
  if (await tryUploadPrimitive({ page, step, fixture: resumeFixture, logger })) {
    logger.info(`step ${stepIndex + 1} resolved by upload primitive`);
    return;
  }

  for (let attempt = 1; attempt <= MAX_STEP_ATTEMPTS; attempt++) {
    if (attempt > 1) {
      await page.waitForTimeout(attempt * ATTEMPT_BACKOFF_MS);
    }

    const pre = await snapshotPage(page, signalCounter);
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
        const result = await stagehand.act(step);
        record.actResultSuccess = result.success;
        record.actResultDescription = result.actionDescription;
        for (const action of result.actions ?? []) {
          if (action.selector) triedSelectors.push(action.selector);
          if (!resolvedAction) resolvedAction = action;
        }
      } else if (attempt === 2 || attempt === 3) {
        record.technique = attempt === 2 ? "observe-act" : "observe-act-exclude";
        const observeOptions =
          attempt === 3 && triedSelectors.length > 0
            ? { ignoreSelectors: [...triedSelectors] }
            : undefined;
        const candidates = observeOptions
          ? await stagehand.observe(step, observeOptions)
          : await stagehand.observe(step);
        if (candidates.length === 0) {
          record.errorMessage = "observe returned no candidates";
        } else {
          const target = candidates[0]!;
          record.instruction = target.description;
          triedSelectors.push(target.selector);
          record.triedSelectors = [target.selector];
          const result = await stagehand.act(target);
          record.actResultSuccess = result.success;
          record.actResultDescription = result.actionDescription;
          // observe(...)[0] is what Stagehand acted on; use it directly when
          // result.actions[] is empty (some Stagehand paths don't echo it back).
          resolvedAction = result.actions?.[0] ?? target;
        }
      } else {
        record.technique = "llm-rephrase";
        if (!anthropic) {
          record.errorMessage = "no anthropic client (bedrock-only deployment); skipping rephrase";
        } else {
          const candidates = await stagehand.observe(step).catch(() => [] as Action[]);
          const rephrased = await rephraseWithLLM(
            anthropic,
            step,
            triedSelectors,
            candidates,
            failureReasons,
            captureFn
          );
          if (!rephrased) {
            record.errorMessage = "llm declined to rephrase or returned IMPOSSIBLE";
          } else {
            record.instruction = rephrased;
            const result = await stagehand.act(rephrased);
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
    const verified = networkFired || urlChanged || domVerified;

    if (verified) {
      record.verifiedBy = urlChanged ? "url" : networkFired ? "network" : "dom";
    }
    // Observational signal: pre/post DOM deltas. Not consumed by the verifier
    // yet — emitted alongside `verifiedBy` so populations (real-nav, state-class,
    // client-side-only, no-op) are tabulatable for threshold tuning. Once a
    // threshold is picked from real recon data, the verifier's click branch
    // will consume this; for now it's measurement only.
    const htmlLengthDelta = post.bodyHtmlLength - pre.bodyHtmlLength;
    const visibleTextChanged = post.visibleTextSignature !== pre.visibleTextSignature;
    logger.info(
      `dom snapshot deltas: step=${stepIndex + 1} attempt=${attempt} htmlLengthDelta=${htmlLengthDelta} visibleTextChanged=${visibleTextChanged} verifiedBy=${record.verifiedBy}`
    );

    // N+16 probe: Stagehand's CDP click sometimes lands on the button without
    // triggering React's SyntheticEvent layer (or jQuery delegated handlers).
    // Empirically: failing Continue clicks produce zero network, zero URL change,
    // zero DOM delta — the React handler never runs. Try invoking the element's
    // native HTMLElement.click() through the JS event pipeline as a fallback;
    // that path is guaranteed to fire registered click handlers. If it produces
    // an observable effect, treat this attempt as healed.
    if (
      !verified &&
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
          const clickExpr = `(() => { const r = document.evaluate(${JSON.stringify(xpath)}, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null); const el = r.singleNodeValue; if (!el || typeof el.click !== "function") return false; el.click(); return true; })()`;
          const fired = await page.evaluate(clickExpr);
          await page.waitForTimeout(STEP_PAUSE_MS);
          const retryPost = await snapshotPage(page, signalCounter);
          const retryNetworkFired = retryPost.networkCount > pre.networkCount;
          const retryUrlChanged = retryPost.url !== pre.url;
          const retryHtmlDelta = retryPost.bodyHtmlLength - pre.bodyHtmlLength;
          const retryTextChanged = retryPost.visibleTextSignature !== pre.visibleTextSignature;
          const retryVerified =
            retryNetworkFired || retryUrlChanged || retryHtmlDelta !== 0 || retryTextChanged;
          logger.info(
            `n+16 probe: step=${stepIndex + 1} attempt=${attempt} el.click() fallback fired=${fired === true}; network=${retryNetworkFired} url=${retryUrlChanged} htmlDelta=${retryHtmlDelta} textChanged=${retryTextChanged} verified=${retryVerified}`
          );
          if (retryVerified) {
            record.verifiedBy = retryUrlChanged ? "url" : retryNetworkFired ? "network" : "dom";
            record.post = retryPost;
            attempts.push(record);
            if (attempt > 1) {
              logger.info(
                `step ${stepIndex + 1} healed on attempt ${attempt} via ${record.technique} + el.click() fallback`
              );
            }
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
      return;
    }

    failureReasons.push(
      record.errorMessage ?? "no observable effect (no network, url, or dom change)"
    );
    logger.warn(
      `step ${stepIndex + 1} attempt ${attempt} (${record.technique}) produced no observable effect — ${failureReasons[failureReasons.length - 1]}`
    );
  }

  const finalObserve = await stagehand.observe(step).catch(() => [] as Action[]);
  const pageTitle = await page.title().catch(() => "");
  // Discriminator data for "Stagehand sees nothing" failures: capture the raw
  // DOM and an unfocused observe so a triager can tell empty-page from
  // Stagehand-can't-see-it without reproducing the failure.
  const bodyOuterHtmlRaw = await page
    .evaluate("document.body ? document.body.outerHTML : null")
    .catch(() => null);
  const bodyOuterHtml =
    typeof bodyOuterHtmlRaw === "string" ? bodyOuterHtmlRaw.slice(0, 100_000) : null;
  const unfocusedObserve = await stagehand.observe().catch(() => [] as Action[]);
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
    `step ${stepIndex + 1} (${step.slice(0, 60)}) failed verification after ${MAX_STEP_ATTEMPTS} attempts; see ${dumpPath}`
  );
}

/** Default resume fixture path; overridable via --resume-fixture or RESUME_FIXTURE_PATH. */
const DEFAULT_RESUME_FIXTURE_PATH = "src/sites/_shared/fixtures/resume.pdf";

function parseCli(): {
  url: string;
  flow: string[];
  captureAll: boolean;
  provider: ProviderName | undefined;
  resumeFixturePath: string;
} {
  const args = process.argv.slice(2);
  let url = "";
  let flow: string[] = [];
  let flowFile: string | null = null;
  let captureAll = false;
  let provider: ProviderName | undefined;
  // Precedence: --resume-fixture flag > RESUME_FIXTURE_PATH env > default path.
  let resumeFixturePath = process.env.RESUME_FIXTURE_PATH || DEFAULT_RESUME_FIXTURE_PATH;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--url" && args[i + 1]) {
      url = args[++i]!;
    } else if (args[i] === "--flow" && args[i + 1]) {
      flow = JSON.parse(args[++i]!) as string[];
    } else if (args[i] === "--flow-file" && args[i + 1]) {
      flowFile = resolve(args[++i]!);
    } else if (args[i] === "--capture-all") {
      captureAll = true;
    } else if (args[i] === "--provider" && args[i + 1]) {
      const raw = args[++i]!.toLowerCase();
      if (raw !== "browserbase" && raw !== "steel") {
        logger.error(`--provider must be "browserbase" or "steel" (got ${JSON.stringify(raw)})`);
        process.exit(1);
      }
      provider = raw;
    } else if (args[i] === "--resume-fixture" && args[i + 1]) {
      resumeFixturePath = args[++i]!;
    }
  }

  if (!url) {
    logger.error(
      'usage: recon-browser.ts --url <url> [--flow \'["step1","step2"]\'] [--flow-file <path>] [--capture-all] [--provider browserbase|steel] [--resume-fixture <path>]'
    );
    process.exit(1);
  }

  if (flowFile) {
    if (flow.length > 0) {
      logger.warn("recon-browser: --flow-file takes precedence over --flow");
    }
    try {
      flow = JSON.parse(readFileSync(flowFile, "utf8")) as string[];
    } catch (err) {
      logger.error(`failed to read --flow-file ${flowFile}: ${toErrorMessage(err)}`);
      process.exit(1);
    }
  }

  return { url, flow, captureAll, provider, resumeFixturePath };
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
  const { url, flow, captureAll, provider, resumeFixturePath } = parseCli();

  mkdirSync(CAPTURES_DIR, { recursive: true });
  const resumeFixture = loadResumeFixture(resumeFixturePath);
  logger.info(
    `recon-browser: target=${url} flow_steps=${flow.length} capture_all=${captureAll} provider=${provider ?? "(config-default)"} resume_fixture=${resumeFixture ? `${resumeFixturePath} (${resumeFixture.buffer.length}b)` : "(missing)"} out=${CAPTURES_DIR}`
  );

  const session = await createBrowserSession({ provider });
  // `counter` indexes captures on disk (filenames must stay unique even for
  // background polls). `signalCounter` drives the verifier — polls don't
  // increment it so coincident polling traffic doesn't falsely "verify"
  // a click that produced no real effect.
  const counter = { n: 0 };
  const signalCounter = { n: 0 };
  const recentCaptures: string[] = [];

  try {
    const stagehand = session.stagehand;
    const page = await stagehand.context.awaitActivePage();

    // Phase label is mutated between flow steps so the single CDP listener
    // always tags captures with the currently active phase.
    let currentPhase = "home";
    const stopCapture = wireNetworkCapture(
      page,
      captureAll,
      counter,
      signalCounter,
      recentCaptures,
      () => currentPhase
    );

    logger.info(`navigating to ${url}`);
    await page.goto(url, { waitUntil: "domcontentloaded", timeoutMs: GOTO_TIMEOUT_MS });

    const anthropic = buildAnthropicClient();
    if (!anthropic) {
      logger.warn(
        "bedrock-only deployment: attempt-4 llm rephrase and global replan will be skipped on step failures"
      );
    }

    const plan: string[] = [...flow];
    const completedSteps: string[] = [];
    let replansUsed = 0;

    for (let i = 0; i < plan.length; i++) {
      const step = plan[i]!;
      currentPhase =
        step
          .replace(/[^a-z0-9]+/gi, "-")
          .toLowerCase()
          .replace(/^-|-$/g, "")
          .slice(0, 24) || `step-${i}`;
      logger.info(`step ${i + 1}/${plan.length} [${currentPhase}]: ${step}`);
      try {
        await executeStepWithHealing({
          stagehand,
          page,
          step,
          stepIndex: i,
          phase: currentPhase,
          signalCounter,
          recentCaptures,
          anthropic,
          logger,
          resumeFixture,
        });
        completedSteps.push(step);
      } catch (err) {
        if (!(err instanceof StepVerificationError)) throw err;
        if (!anthropic || replansUsed >= MAX_REPLANS) throw err;

        replansUsed++;
        const originalRemaining = plan.slice(i + 1);
        const dumpMatch = err.message.match(/see (\/[^\s]+)$/);
        const dumpPath = dumpMatch ? dumpMatch[1]! : "";
        logger.warn(
          `step ${i + 1} terminally failed; attempting global replan #${replansUsed}/${MAX_REPLANS}`
        );

        const newSteps = await replanRemainingFlow({
          client: anthropic,
          originalFlow: flow,
          completedSteps,
          failedStep: step,
          remainingSteps: originalRemaining,
          failureDumpPath: dumpPath,
          page,
          stagehand,
        });

        if (!newSteps) {
          logger.error(
            `replan #${replansUsed} returned IMPOSSIBLE or unparseable output; aborting`
          );
          throw err;
        }

        const replanPath = dumpReplanRecord({
          stepIndex: i,
          phase: currentPhase,
          replanIndex: replansUsed,
          completedSteps,
          originalRemaining,
          newRemaining: newSteps,
        });
        logger.info(
          `replan #${replansUsed} produced ${newSteps.length} new step(s); resuming (record: ${replanPath})`
        );
        for (const [j, s] of newSteps.entries()) {
          logger.info(`  replanned step ${j + 1}: ${s}`);
        }

        plan.splice(i, plan.length - i, ...newSteps);
        i--;
      }
    }

    stopCapture();
    logger.info(`recon complete — ${counter.n} captures written to ${CAPTURES_DIR}`);
  } finally {
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

// Test-only exports — allow unit tests to inject a fake capture sink without
// touching the main() entry-point or the real browser session.
export { rephraseWithLLM, replanRemainingFlow };
