/**
 * Phase 1 recon: drives a real browser through a user-defined flow while
 * wiretapping every network response. Captures are written to
 * /tmp/recon/graphql/<NNN>-<phase>-<operationName>.json — one file per call,
 * diffable and greppable.
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
 * The script needs STEEL_API_KEY and either ANTHROPIC_API_KEY or USE_BEDROCK=true
 * in the environment (same vars as the main server).
 *
 * Runtime: varies — ~20–40 min for a full flow (STEP_PAUSE_MS × N steps + LLM latency per act).
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import type { Page } from "@browserbasehq/stagehand";

import { configureHttpDispatcher } from "@/lib/http";
import { getScriptLogger } from "@/lib/logging";
import { createBrowserSession } from "@/scraper/session";
import { CAPTURES_DIR, type Capture } from "@/scripts/recon-shared";

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
      logger.error(`failed to read --flow-file ${flowFile}: ${String(err)}`);
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

  try {
    const stagehand = session.stagehand;
    const page = await stagehand.context.awaitActivePage();

    // Phase label is mutated between flow steps so the single CDP listener
    // always tags captures with the currently active phase.
    let currentPhase = "home";
    const stopCapture = wireNetworkCapture(page, captureAll, counter, () => currentPhase);

    logger.info(`navigating to ${url}`);
    await page.goto(url, { waitUntil: "domcontentloaded", timeoutMs: GOTO_TIMEOUT_MS });

    for (let i = 0; i < flow.length; i++) {
      const step = flow[i]!;
      currentPhase =
        step
          .replace(/[^a-z0-9]+/gi, "-")
          .toLowerCase()
          .replace(/^-|-$/g, "")
          .slice(0, 24) || `step-${i}`;
      logger.info(`step ${i + 1}/${flow.length} [${currentPhase}]: ${step}`);
      await stagehand.act(step);
      await page.waitForTimeout(STEP_PAUSE_MS);
    }

    stopCapture();
    logger.info(`recon complete — ${counter.n} captures written to ${CAPTURES_DIR}`);
  } finally {
    await session.close();
  }
}

main().catch((err) => {
  // StagehandDefaultError wraps the real cause with a verbose "Hey! We're sorry..." banner.
  // Unwrap it so the log shows just the meaningful error message.
  const message =
    err instanceof Error && err.cause instanceof Error ? err.cause.message : String(err);
  logger.error(`recon-browser failed: ${message}`);
  process.exit(1);
});
