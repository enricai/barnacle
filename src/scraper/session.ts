import { AISdkClient, type ModelConfiguration, Stagehand } from "@browserbasehq/stagehand";
import type Bottleneck from "bottleneck";
import Steel from "steel-sdk";

import { config } from "@/config";
import { createBedrockModel } from "@/lib/bedrock";
import { getLogger } from "@/lib/logging";
import { createSessionLimiter } from "@/scraper/throttle";

const logger = getLogger({ name: "scraper/session" });

/**
 * Returns a fetch wrapper that aborts after `timeoutMs` milliseconds.
 * Handles the total request timeout for Anthropic API calls; the TCP connect
 * timeout is handled separately via setGlobalDispatcher in server.ts.
 */
function createTimeoutFetch(timeoutMs: number): typeof fetch {
  return (url, init) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    // Merge with any existing signal from the caller (e.g. AI SDK's own abort signal)
    // so both can independently cancel the request.
    const signals = [controller.signal, init?.signal].filter(
      (s): s is AbortSignal => s instanceof AbortSignal
    );
    const signal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];
    return fetch(url, { ...init, signal }).finally(() => clearTimeout(timer));
  };
}

/**
 * Common desktop viewports rotated per session to reduce bot-detection
 * fingerprinting — a fixed pixel size is an easy signal to filter on.
 */
const VIEWPORTS = [
  { width: 1280, height: 720 },
  { width: 1366, height: 768 },
  { width: 1440, height: 900 },
  { width: 1920, height: 1080 },
] as const;

function pickRandomViewport(): { width: number; height: number } {
  // Math.floor(Math.random() * len) is always < len, so the indexed
  // access is total — no need for a non-null assertion.
  const index = Math.floor(Math.random() * VIEWPORTS.length);
  return VIEWPORTS[index] ?? VIEWPORTS[0];
}

/**
 * A live browser session paired with the per-session action limiter.
 * Callers MUST call `close()` in a `finally` block so Steel bills stop
 * accruing and the underlying browser process is released.
 */
export interface BrowserSession {
  stagehand: Stagehand;
  limiter: Bottleneck;
  /** Opaque Steel session ID — useful for log correlation. */
  sessionId: string;
  close(): Promise<void>;
}

/**
 * Spins up one Steel cloud browser session with residential proxies +
 * the configured Stagehand LLM, connected via Steel's CDP endpoint.
 *
 * Why residential proxies: many target sites are more reliably reachable
 * from residential IPs; datacenter ranges are commonly flagged.
 *
 * Why serverCache=true: Stagehand's server-side cache skips LLM inference on
 * replay. After the first run against a page structure, subsequent `act()`
 * calls complete in milliseconds. When the target page UI changes and a cached
 * action fails, retry.ts wraps the next attempt — that's our recovery layer.
 *
 * Why selfHeal=false: Stagehand's built-in self-heal only fires on Playwright
 * throws (element-not-found / intercepted / timeout). It does NOT catch the
 * silent-semantic-miss case ("clicked the wrong thing, returned success"), it
 * has open variable-loss / cache-write bugs on `main`, and the docs themselves
 * default it off and steer production users toward observe → act. Recon-browser
 * owns its own verify-and-retry cascade; the runtime path uses retry.ts. Keeping
 * this off makes failure semantics clean — `act()` throws or succeeds, and our
 * code decides what to do next.
 */
export async function createBrowserSession(): Promise<BrowserSession> {
  if (!config.scraper.steelApiKey) {
    throw new Error("STEEL_API_KEY is required to create a browser session");
  }
  if (!config.scraper.useBedrock && !config.scraper.anthropicApiKey) {
    throw new Error("ANTHROPIC_API_KEY is required for the Stagehand LLM client");
  }

  const steel = new Steel({ steelAPIKey: config.scraper.steelApiKey });

  const viewport = pickRandomViewport();
  const session = await steel.sessions.create({
    timeout: config.scraper.steelSessionTimeoutMs,
    // Lowercase the env value so SCRAPER_PROXY_TYPE="Residential" /
    // "RESIDENTIAL" don't silently turn the proxy off.
    useProxy: config.scraper.proxyType.toLowerCase() === "residential",
    solveCaptcha: config.scraper.solveCaptcha,
    dimensions: viewport,
  });

  // Once `sessions.create` resolves, Steel is billing for the remote session.
  // Any failure between here and a successful return must release the session
  // explicitly — otherwise a Stagehand init crash or Stagehand CDP connection
  // failure leaves a live session burning minutes until Steel's own timeout.
  let stagehand: Stagehand | undefined;
  try {
    // Steel's websocketUrl is `wss://connect.steel.dev?sessionId=…`. Stagehand's
    // V3 CDP connector requires the apiKey as a query parameter too — without it
    // the connection returns a 502 before the CDP handshake completes.
    const cdpUrl = session.websocketUrl.includes("apiKey=")
      ? session.websocketUrl
      : `${session.websocketUrl}&apiKey=${encodeURIComponent(config.scraper.steelApiKey)}`;
    logger.info(
      `created steel session ${session.id} viewport=${viewport.width}x${viewport.height}`
    );
    if (config.scraper.useBedrock) {
      logger.info(`using bedrock model ${config.bedrock.model} in region ${config.bedrock.region}`);
    }

    const llmClient = config.scraper.useBedrock
      ? new AISdkClient({ model: createBedrockModel(config.bedrock) })
      : undefined;

    stagehand = new Stagehand({
      env: "LOCAL",
      model: config.scraper.useBedrock
        ? undefined
        : ({
            modelName: config.scraper.model,
            apiKey: config.scraper.anthropicApiKey,
            // @ai-sdk/anthropic has no `timeout` option; inject timeout at the fetch layer.
            fetch: createTimeoutFetch(config.scraper.anthropicTimeoutMs),
          } as ModelConfiguration),
      llmClient,
      serverCache: true,
      selfHeal: false,
      localBrowserLaunchOptions: { cdpUrl },
      verbose: 0,
    });

    await stagehand.init();
  } catch (err) {
    // Best-effort cleanup; swallow secondary failures so the original
    // error surfaces to the caller.
    try {
      if (stagehand) await stagehand.close();
    } catch (closeErr) {
      logger.warn(`stagehand close during failed init: ${String(closeErr)}`);
    }
    try {
      await steel.sessions.release(session.id);
    } catch (releaseErr) {
      logger.warn(`steel release during failed init for ${session.id}: ${String(releaseErr)}`);
    }
    throw err;
  }

  const limiter = createSessionLimiter();

  const close = async (): Promise<void> => {
    try {
      await stagehand.close();
    } catch (err) {
      logger.warn(`stagehand close failed for session ${session.id}: ${String(err)}`);
    }
    try {
      await steel.sessions.release(session.id);
    } catch (err) {
      logger.warn(`steel release failed for session ${session.id}: ${String(err)}`);
    }
    await limiter.stop({ dropWaitingJobs: true });
  };

  return {
    stagehand,
    limiter,
    sessionId: session.id,
    close,
  };
}
