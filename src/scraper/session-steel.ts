import { AISdkClient, type ModelConfiguration, Stagehand } from "@browserbasehq/stagehand";
import Steel from "steel-sdk";

import { config } from "@/config";
import { createBedrockModel } from "@/lib/bedrock";
import { toErrorMessage } from "@/lib/errors";
import { getLogger } from "@/lib/logging";
import {
  type BrowserSession,
  createTimeoutFetch,
  pickRandomViewport,
} from "@/scraper/session-shared";
import { createSessionLimiter } from "@/scraper/throttle";

const logger = getLogger({ name: "scraper/session-steel" });

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
 *
 * Why `env: "LOCAL"`: Steel sessions connect via a CDP URL, not Stagehand's
 * first-party Browserbase integration. This means several Stagehand code paths
 * gated on `env === "BROWSERBASE"` (file upload payload injection, tuned CDP
 * timeouts, session recovery, event-window timing) stay inactive — accept this
 * trade-off as the cost of Steel support. Switch to the Browserbase provider
 * to activate those paths.
 */
export async function createSteelBrowserSession(): Promise<BrowserSession> {
  if (!config.scraper.steelApiKey) {
    throw new Error("STEEL_API_KEY is required for the steel provider");
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
      logger.warn(`stagehand close during failed init: ${toErrorMessage(closeErr)}`);
    }
    try {
      await steel.sessions.release(session.id);
    } catch (releaseErr) {
      logger.warn(
        `steel release during failed init for ${session.id}: ${toErrorMessage(releaseErr)}`
      );
    }
    throw err;
  }

  const limiter = createSessionLimiter();

  const close = async (): Promise<void> => {
    try {
      await stagehand.close();
    } catch (err) {
      logger.warn(`stagehand close failed for session ${session.id}: ${toErrorMessage(err)}`);
    }
    try {
      await steel.sessions.release(session.id);
    } catch (err) {
      logger.warn(`steel release failed for session ${session.id}: ${toErrorMessage(err)}`);
    }
    await limiter.stop({ dropWaitingJobs: true });
  };

  return {
    stagehand,
    limiter,
    sessionId: session.id,
    provider: "steel",
    close,
  };
}
