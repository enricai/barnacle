import { AISdkClient, type ModelConfiguration, Stagehand } from "@browserbasehq/stagehand";

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

const logger = getLogger({ name: "scraper/session-browserbase" });

/**
 * Spins up one Browserbase cloud session with the configured Stagehand LLM.
 *
 * Why Browserbase (and why it's the default): Stagehand v3 has five distinct
 * code paths gated on `env === "BROWSERBASE"` — file-input payload injection
 * for remote uploads, tuned CDP connection timeouts, session-recovery logic,
 * and event-window timing for the active-page detection. Steel-over-CDP
 * (env: "LOCAL") misses all five. Defaulting to Browserbase keeps us on the
 * code path Stagehand validates first.
 *
 * Session lifecycle: Stagehand owns Browserbase session creation when
 * `env: "BROWSERBASE"` is set. `stagehand.close()` releases the session;
 * no separate Browserbase SDK release call is needed (unlike Steel).
 *
 * Viewport rotation: forwarded via `fingerprint.screen.{min,max}{Width,Height}`
 * pinned to the chosen viewport. The min/max bracket forces Browserbase's
 * fingerprint generator to pick that exact size rather than negotiating it.
 *
 * Proxies: `proxies: true` enables Browserbase's residential proxy pool. The
 * boolean form takes Browserbase's default region; per-region routing is
 * available via the array form (not used here — out of scope until needed).
 */
/**
 * `advancedStealth` opts into Browserbase's Scale Plan stealth profile. When
 * enabled we also force `solveCaptchas: true` (explicit; Browserbase defaults
 * it on) and pin a Windows desktop fingerprint — DataDome-protected sites
 * (notably `apply.appcast.io`) react significantly better to Windows OS
 * signals than the default mac/linux mix. Pattern mirrors nursefly-web's
 * production preset at `server/jobs/ingest/scraped/browserbase/stagehand.config.ts`.
 */
export async function createBrowserbaseBrowserSession(opts?: {
  advancedStealth?: boolean;
}): Promise<BrowserSession> {
  if (!config.scraper.browserbaseApiKey) {
    throw new Error("BROWSERBASE_API_KEY is required for the browserbase provider");
  }
  if (!config.scraper.browserbaseProjectId) {
    throw new Error("BROWSERBASE_PROJECT_ID is required for the browserbase provider");
  }
  if (!config.scraper.useBedrock && !config.scraper.anthropicApiKey) {
    throw new Error("ANTHROPIC_API_KEY is required for the Stagehand LLM client");
  }

  const viewport = pickRandomViewport();
  const useResidentialProxy = config.scraper.proxyType.toLowerCase() === "residential";
  const advancedStealth = opts?.advancedStealth === true;

  if (config.scraper.useBedrock) {
    logger.info(`using bedrock model ${config.bedrock.model} in region ${config.bedrock.region}`);
  }

  const llmClient = config.scraper.useBedrock
    ? new AISdkClient({ model: createBedrockModel(config.bedrock) })
    : undefined;

  // Base fingerprint always pins the screen size. Advanced stealth layers on
  // desktop + Windows OS hints; the stronger fingerprint is required for
  // DataDome-protected flows.
  const baseFingerprint = {
    screen: {
      minWidth: viewport.width,
      maxWidth: viewport.width,
      minHeight: viewport.height,
      maxHeight: viewport.height,
    },
  };
  const fingerprint = advancedStealth
    ? {
        ...baseFingerprint,
        devices: ["desktop" as const],
        operatingSystems: ["windows" as const],
      }
    : baseFingerprint;

  let stagehand: Stagehand | undefined;
  try {
    stagehand = new Stagehand({
      env: "BROWSERBASE",
      apiKey: config.scraper.browserbaseApiKey,
      projectId: config.scraper.browserbaseProjectId,
      browserbaseSessionCreateParams: {
        projectId: config.scraper.browserbaseProjectId,
        proxies: useResidentialProxy,
        browserSettings: {
          ...(advancedStealth ? { advancedStealth: true, solveCaptchas: true } : {}),
          fingerprint,
        },
      },
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
      verbose: 0,
    });

    await stagehand.init();
  } catch (err) {
    try {
      if (stagehand) await stagehand.close();
    } catch (closeErr) {
      logger.warn(`stagehand close during failed init: ${toErrorMessage(closeErr)}`);
    }
    throw err;
  }

  const sessionId = stagehand.browserbaseSessionID ?? "unknown";
  logger.info(
    `created browserbase session ${sessionId} viewport=${viewport.width}x${viewport.height} proxies=${useResidentialProxy} advancedStealth=${advancedStealth}`
  );

  const limiter = createSessionLimiter();

  const close = async (): Promise<void> => {
    try {
      await stagehand.close();
    } catch (err) {
      logger.warn(`stagehand close failed for session ${sessionId}: ${toErrorMessage(err)}`);
    }
    await limiter.stop({ dropWaitingJobs: true });
  };

  return {
    stagehand,
    limiter,
    sessionId,
    provider: "browserbase",
    close,
  };
}
