import { Stagehand } from "@browserbasehq/stagehand";
import type Bottleneck from "bottleneck";
import Steel from "steel-sdk";

import { config } from "@/config";
import { getLogger } from "@/lib/logging";
import { createSessionLimiter } from "@/scraper/throttle";

const logger = getLogger({ name: "scraper/session" });

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
 * Why we use Steel's residential proxies by default: RC blocks datacenter
 * IPs aggressively. Residential is the only option that works consistently.
 *
 * Why enableCaching=true: Stagehand's built-in action cache skips LLM
 * inference on replay. After the first run against a page structure,
 * subsequent `act()` calls complete in milliseconds. When RC changes the
 * UI and a cached action fails, Stagehand automatically falls back to
 * fresh AI resolution; our retry.ts wraps that in a retry policy.
 */
export async function createBrowserSession(): Promise<BrowserSession> {
  if (!config.scraper.steelApiKey) {
    throw new Error("STEEL_API_KEY is required to create a browser session");
  }
  if (!config.scraper.anthropicApiKey) {
    throw new Error("ANTHROPIC_API_KEY is required for the Stagehand LLM client");
  }

  const steel = new Steel({ steelAPIKey: config.scraper.steelApiKey });

  const session = await steel.sessions.create({
    useProxy: config.scraper.proxyType === "residential",
    solveCaptcha: config.scraper.solveCaptcha,
  });

  // Steel's websocketUrl is `wss://connect.steel.dev?sessionId=…`. Playwright's
  // connectOverCDP requires the apiKey as a query parameter too — without it
  // the connection returns a 502 before the CDP handshake completes.
  const cdpUrl = session.websocketUrl.includes("apiKey=")
    ? session.websocketUrl
    : `${session.websocketUrl}&apiKey=${encodeURIComponent(config.scraper.steelApiKey)}`;
  logger.info(`created steel session ${session.id}`);

  const stagehand = new Stagehand({
    env: "LOCAL",
    modelName: config.scraper.model as never,
    modelClientOptions: { apiKey: config.scraper.anthropicApiKey },
    enableCaching: true,
    localBrowserLaunchOptions: { cdpUrl },
    verbose: 0,
  });

  await stagehand.init();

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
