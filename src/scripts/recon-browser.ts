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
import type { Action, Page, Stagehand } from "@browserbasehq/stagehand";
import { z } from "zod/v4";

import { config } from "@/config";
import { toErrorMessage } from "@/lib/errors";
import { configureHttpDispatcher } from "@/lib/http";
import { getScriptLogger } from "@/lib/logging";
import { captureLlmCall, type LlmCallInput } from "@/lib/telemetry/call-capture";
import { CALL_TYPE_RECON_REPHRASE, CALL_TYPE_RECON_REPLAN } from "@/lib/telemetry/call-types";
import { StepVerificationError } from "@/scraper/errors";
import { createBrowserSession } from "@/scraper/session";
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

function shouldCapture(url: string, captureAll: boolean): boolean {
  if (captureAll) return true;
  return CAPTURE_PATTERNS.some((p) => p.test(url));
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
}

function snapshotPage(page: Page, counter: { n: number }): StepSnapshot {
  return { networkCount: counter.n, url: page.url() };
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

const REPLAN_RESPONSE_SCHEMA = z.array(z.string().min(1)).min(1).max(REPLAN_MAX_STEPS);

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

ELEMENTS CURRENTLY VISIBLE ON THE PAGE:
${candidateList || "(no candidates returned by observe)"}

DIAGNOSTIC DUMP OF THE FAILED STEP:
${failureDumpPath}

Rewrite the remaining flow so the agent can reach the user's original intent from where it is now. You may:
- reorder remaining steps
- insert new steps (e.g. an "open the section first" prerequisite the original flow missed)
- drop redundant steps
- rephrase steps to be unambiguous given the current page state

Constraints:
- Do NOT include the already-completed steps in your output — only the new remaining tail to execute from here.
- Return ONLY a JSON array of strings — no prose, no markdown, no code fences.
- If the user's intent is unreachable from this page state, reply with the literal string IMPOSSIBLE.
- Maximum ${REPLAN_MAX_STEPS} steps.`;

  const model = anthropicModelName();
  const t0 = performance.now();
  try {
    const response = await client.messages.create({
      model,
      max_tokens: 2000,
      messages: [{ role: "user", content: prompt }],
    });
    const latencyMs = performance.now() - t0;
    const block = response.content.find((b) => b.type === "text");
    const rawText = block?.type === "text" ? block.text.trim() : "";

    if (rawText === "IMPOSSIBLE" || rawText.length === 0) {
      await captureFn({
        callId: randomUUID(),
        callType: CALL_TYPE_RECON_REPLAN,
        model,
        systemPrompt: null,
        userContent: prompt,
        responseContent: rawText || null,
        parsedOk: false,
        inputTokens: response.usage?.input_tokens ?? null,
        outputTokens: response.usage?.output_tokens ?? null,
        latencyMs,
        success: false,
      });
      return null;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawText);
    } catch {
      await captureFn({
        callId: randomUUID(),
        callType: CALL_TYPE_RECON_REPLAN,
        model,
        systemPrompt: null,
        userContent: prompt,
        responseContent: rawText,
        parsedOk: false,
        inputTokens: response.usage?.input_tokens ?? null,
        outputTokens: response.usage?.output_tokens ?? null,
        latencyMs,
        success: false,
      });
      return null;
    }

    const validated = REPLAN_RESPONSE_SCHEMA.safeParse(parsed);
    const parsedOk = validated.success;

    await captureFn({
      callId: randomUUID(),
      callType: CALL_TYPE_RECON_REPLAN,
      model,
      systemPrompt: null,
      userContent: prompt,
      responseContent: rawText,
      parsedOk,
      inputTokens: response.usage?.input_tokens ?? null,
      outputTokens: response.usage?.output_tokens ?? null,
      latencyMs,
      success: parsedOk,
    });

    if (!parsedOk) return null;
    return validated.data;
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
    recentCaptures: params.recentCaptures.slice(-5),
  };
  const target = join(STEP_FAILURES_DIR, filename);
  writeFileSync(target, JSON.stringify(bundle, null, 2));
  return target;
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
  counter: { n: number };
  recentCaptures: string[];
  anthropic: Anthropic | null;
  logger: Logger;
  captureFn?: CaptureFn;
}): Promise<void> {
  const {
    stagehand,
    page,
    step,
    stepIndex,
    phase,
    counter,
    recentCaptures,
    anthropic,
    logger,
    captureFn,
  } = params;
  const attempts: AttemptRecord[] = [];
  const triedSelectors: string[] = [];
  const failureReasons: string[] = [];

  for (let attempt = 1; attempt <= MAX_STEP_ATTEMPTS; attempt++) {
    if (attempt > 1) {
      await page.waitForTimeout(attempt * ATTEMPT_BACKOFF_MS);
    }

    const pre = snapshotPage(page, counter);
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
    };

    try {
      if (attempt === 1) {
        record.technique = "act-string";
        record.instruction = step;
        const result = await stagehand.act(step);
        record.actResultSuccess = result.success;
        record.actResultDescription = result.actionDescription;
        for (const action of result.actions ?? []) {
          if (action.selector) triedSelectors.push(action.selector);
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
            }
          }
        }
      }
    } catch (err) {
      const cause = err instanceof Error && err.cause instanceof Error ? err.cause.message : null;
      record.errorMessage = `${toErrorMessage(err)}${cause ? ` (cause: ${cause})` : ""}`;
    }

    await page.waitForTimeout(STEP_PAUSE_MS);
    const post = snapshotPage(page, counter);
    record.post = post;

    const networkFired = post.networkCount > pre.networkCount;
    const urlChanged = post.url !== pre.url;
    const verified = networkFired || urlChanged;

    attempts.push(record);

    if (verified) {
      if (attempt > 1) {
        logger.info(
          `step ${stepIndex + 1} healed on attempt ${attempt} via ${record.technique} (network=${networkFired} url=${urlChanged})`
        );
      }
      return;
    }

    failureReasons.push(record.errorMessage ?? "no observable effect (no network or url change)");
    logger.warn(
      `step ${stepIndex + 1} attempt ${attempt} (${record.technique}) produced no observable effect — ${failureReasons[failureReasons.length - 1]}`
    );
  }

  const finalObserve = await stagehand.observe(step).catch(() => [] as Action[]);
  const pageTitle = await page.title().catch(() => "");
  const dumpPath = dumpStepFailure({
    stepIndex,
    phase,
    originalStep: step,
    attempts,
    finalObserve,
    pageUrl: page.url(),
    pageTitle,
    recentCaptures,
  });
  logger.error(
    `step ${stepIndex + 1} failed after ${MAX_STEP_ATTEMPTS} attempts; diagnostic bundle: ${dumpPath}`
  );
  throw new StepVerificationError(
    `step ${stepIndex + 1} (${step.slice(0, 60)}) failed verification after ${MAX_STEP_ATTEMPTS} attempts; see ${dumpPath}`
  );
}

function parseCli(): { url: string; flow: string[]; captureAll: boolean } {
  const args = process.argv.slice(2);
  let url = "";
  let flow: string[] = [];
  let flowFile: string | null = null;
  let captureAll = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--url" && args[i + 1]) {
      url = args[++i]!;
    } else if (args[i] === "--flow" && args[i + 1]) {
      flow = JSON.parse(args[++i]!) as string[];
    } else if (args[i] === "--flow-file" && args[i + 1]) {
      flowFile = resolve(args[++i]!);
    } else if (args[i] === "--capture-all") {
      captureAll = true;
    }
  }

  if (!url) {
    logger.error(
      'usage: recon-browser.ts --url <url> [--flow \'["step1","step2"]\'] [--flow-file <path>] [--capture-all]'
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

  return { url, flow, captureAll };
}

async function main(): Promise<void> {
  const { url, flow, captureAll } = parseCli();

  mkdirSync(CAPTURES_DIR, { recursive: true });
  logger.info(
    `recon-browser: target=${url} flow_steps=${flow.length} capture_all=${captureAll} out=${CAPTURES_DIR}`
  );

  const session = await createBrowserSession();
  const counter = { n: 0 };
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
          counter,
          recentCaptures,
          anthropic,
          logger,
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
