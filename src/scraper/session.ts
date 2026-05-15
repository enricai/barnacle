import { AISdkClient, Stagehand } from "@browserbasehq/stagehand";
import type Bottleneck from "bottleneck";
import Steel from "steel-sdk";

import { config } from "@/config";
import { createBedrockModel } from "@/lib/bedrock";
import { getLogger } from "@/lib/logging";
import { createSessionLimiter } from "@/scraper/throttle";

const logger = getLogger({ name: "scraper/session" });

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
 * Why residential proxies: government portals are more reliably reachable
 * from residential IPs; datacenter ranges are commonly flagged.
 *
 * Why enableCaching=true: Stagehand's built-in action cache skips LLM
 * inference on replay. After the first run against a page structure,
 * subsequent `act()` calls complete in milliseconds. When the form UI
 * changes and a cached action fails, Stagehand automatically falls back
 * to fresh AI resolution; retry.ts wraps that in a retry policy.
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
    // Lowercase the env value so SCRAPER_PROXY_TYPE="Residential" /
    // "RESIDENTIAL" don't silently turn the proxy off.
    useProxy: config.scraper.proxyType.toLowerCase() === "residential",
    solveCaptcha: config.scraper.solveCaptcha,
    dimensions: viewport,
  });

  // Once `sessions.create` resolves, Steel is billing for the remote session.
  // Any failure between here and a successful return must release the session
  // explicitly — otherwise a Stagehand init crash or Playwright CDP handshake
  // failure leaves a live session burning minutes until Steel's own timeout.
  let stagehand: Stagehand | undefined;
  try {
    // Steel's websocketUrl is `wss://connect.steel.dev?sessionId=…`. Playwright's
    // connectOverCDP requires the apiKey as a query parameter too — without it
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
      ? new AISdkClient({ model: createBedrockModel(config.bedrock), enableCaching: true })
      : undefined;

    stagehand = new Stagehand({
      env: "LOCAL",
      modelName: config.scraper.useBedrock ? undefined : config.scraper.model,
      modelClientOptions: config.scraper.useBedrock
        ? undefined
        : { apiKey: config.scraper.anthropicApiKey },
      llmClient,
      enableCaching: true,
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
