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
  recentCaptureMeta: { method: string; status: number }[],
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
    // signal. We approximate "action-driven" with "non-GET method": real form
    // submits, uploads, and state-change calls are POST/PUT/PATCH/DELETE.
    // GETs are page-load chrome, polls, and idle prefetches — none of which
    // are caused by the user step we just executed.
    //
    // This replaces a prior URL-shape regex (POLLING_URL_PATTERNS) that
    // misclassified jQuery-cache-busted page-load GETs as polls. See
    // feedback_no_regex_open_sets — URL classification is an open-set
    // problem; HTTP method is a closed-set discriminator.
    //
    // Filename indexing stays on `counter` so polls still get unique
    // filenames on disk.
    if (req.method !== "GET") {
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
    // GETs are static asset chunks, polls, and idle prefetches — none are
    // user-action signals. Filter them out at the source so Tier 1's mutation
    // window (size RECENT_CAPTURES_WINDOW) doesn't get washed out by SPA
    // chunk loads between meaningful mutations. Same discriminator signalCounter
    // uses for the per-step verifier.
    if (capture.method !== "GET") {
      recentCaptureMeta.push({ method: capture.method, status: capture.status });
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

/** Internal normalized step shape. Source-flow strings normalize with all flags false. */
interface NormalizedStep {
  instruction: string;
  optional: boolean;
  upload: boolean;
}

function normalizeFlow(steps: z.infer<typeof RECON_FLOW_SCHEMA>): NormalizedStep[] {
  return steps.map((s) =>
    typeof s === "string"
      ? { instruction: s, optional: false, upload: false }
      : { instruction: s.step, optional: s.optional, upload: s.upload }
  );
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
}): void {
  const { flowFile, finalPlan, replanEvents, logger } = params;
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

  const denormalized = finalPlan.map(denormalizeStep);
  // 2-space indent + trailing newline matches the existing on-disk style
  // (verified against clearcompany/appcast/getgreatcareers recon-flow.json).
  writeFileSync(flowFile, `${JSON.stringify(denormalized, null, 2)}\n`);

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
  } = params;
  const candidates = await stagehand
    .observe({ timeout: STEP_WATCHDOG_MS })
    .catch(() => [] as Action[]);
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
    });

    if (parsed.outcome === "replan") return normalizeFlow(parsed.steps);
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
  anthropic: Anthropic | null;
  logger: Logger;
  captureFn?: CaptureFn;
  resumeFixture: { buffer: Buffer; name: string; mimeType: string } | null;
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
    anthropic,
    logger,
    captureFn,
    resumeFixture,
  } = params;
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
    return;
  }

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
    throw new StepVerificationError(
      `step ${stepIndex + 1} (${step.slice(0, 60)}) probe found no candidates on page`,
      "probe-absent"
    );
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
              input = start.querySelector('input[type="radio"], input[type="checkbox"]');
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
        } else {
          const candidates = await stagehand
            .observe(step, { timeout: STEP_WATCHDOG_MS })
            .catch(() => [] as Action[]);
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
          const checkboxStateVerified =
            probeResult.kind === "checkbox" && probeResult.checked === true;
          await page.waitForTimeout(STEP_PAUSE_MS);
          const retryPost = await snapshotPage(page, signalCounter);
          const retryNetworkFired = retryPost.networkCount > pre.networkCount;
          const retryUrlChanged = retryPost.url !== pre.url;
          const retryHtmlDelta = retryPost.bodyHtmlLength - pre.bodyHtmlLength;
          const retryTextChanged = retryPost.visibleTextSignature !== pre.visibleTextSignature;
          const retryVerified =
            retryNetworkFired ||
            retryUrlChanged ||
            retryHtmlDelta !== 0 ||
            retryTextChanged ||
            checkboxStateVerified;
          logger.info(
            `n+16 probe: step=${stepIndex + 1} attempt=${attempt} el.click() fallback fired=${fired === true} kind=${probeResult.kind ?? "none"} checkboxStateVerified=${checkboxStateVerified}; network=${retryNetworkFired} url=${retryUrlChanged} htmlDelta=${retryHtmlDelta} textChanged=${retryTextChanged} verified=${retryVerified}`
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
    }
  }

  if (!url) {
    logger.error(
      'usage: recon-browser.ts --url <url> [--flow \'["step1","step2"]\'] [--flow-file <path>] [--provider browserbase|steel] [--resume-fixture <path>] [--no-save-replan] [--advanced-stealth] [--dump-dom-before-step <N>]'
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
    };
  }
  const parsed = RECON_FLOW_SCHEMA.safeParse(rawFlow);
  if (!parsed.success) {
    logger.error(`flow file/arg failed schema validation: ${parsed.error.message}`);
    process.exit(1);
  }
  return {
    url,
    flow: normalizeFlow(parsed.data),
    flowFile,
    provider,
    resumeFixturePath,
    saveReplan,
    advancedStealth,
    dumpDomBeforeStep,
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
    flow,
    flowFile,
    provider,
    resumeFixturePath,
    saveReplan,
    advancedStealth,
    dumpDomBeforeStep,
  } = parseCli();

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
  const recentCaptureMeta: { method: string; status: number }[] = [];

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

    const plan: NormalizedStep[] = [...flow];
    const completedSteps: string[] = [];
    let probeReplansUsed = 0;
    let cascadeReplansUsed = 0;
    const replanEvents: ReplanEvent[] = [];

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
          anthropic,
          logger,
          resumeFixture,
        });
        completedSteps.push(step.instruction);
      } catch (err) {
        if (!(err instanceof StepVerificationError)) throw err;

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
          logger.error(
            `step ${i + 1} ${err.kind} replan budget exhausted (${usedSoFar}/${budget}); aborting`
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
        plan.splice(i, plan.length - i, ...newSteps, ...originalRemaining);
        i--;
      }
    }

    stopCapture();
    logger.info(`recon complete — ${counter.n} captures written to ${CAPTURES_DIR}`);

    // Replay-the-discovered-path: if any replan fired and the user provided a
    // flow file, write the improved plan back so the next run starts where
    // this one ended up. Skipped on --no-save-replan (diagnostic dry-runs)
    // and when --flow was used inline (no file to write back to).
    if (replanEvents.length > 0) {
      if (!saveReplan) {
        logger.info(
          `run completed with ${replanEvents.length} replan event(s); --no-save-replan, leaving flow.json unchanged`
        );
      } else if (!flowFile) {
        logger.info(
          `run completed with ${replanEvents.length} replan event(s); --flow used (no file to write back to)`
        );
      } else {
        logger.info(`run completed; writing flow.json with ${replanEvents.length} replan event(s)`);
        persistReplannedFlow({ flowFile, finalPlan: plan, replanEvents, logger });
      }
    }
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

export type { NormalizedStep, ReplanEvent };
// Test-only exports — allow unit tests to inject a fake capture sink without
// touching the main() entry-point or the real browser session.
export { denormalizeStep, persistReplannedFlow, rephraseWithLLM, replanRemainingFlow };
