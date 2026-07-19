import { AISdkClient, type ModelConfiguration, Stagehand } from "@browserbasehq/stagehand";

import { config } from "@/config";
import { createBedrockModel } from "@/lib/bedrock";
import { toErrorMessage } from "@/lib/errors";
import { getLogger } from "@/lib/logging";
import {
  type BrowserSession,
  type BrowserSessionOptions,
  createTimeoutFetch,
  pickRandomViewport,
} from "@/scraper/session-shared";
import { createSessionLimiter } from "@/scraper/throttle";
import type { Logger } from "@/types/logging";

const logger = getLogger({ name: "scraper/session-browserbase" });

/**
 * Shape of the LogLine objects Stagehand passes to its `logger` callback.
 * We declare a minimal local subset rather than importing from Stagehand
 * because the type isn't re-exported from the package's top-level entrypoint.
 */
export interface StagehandLogLine {
  message: string;
  category?: string;
  level?: number;
  auxiliary?: Record<string, { value: string; type: string }>;
}

/**
 * Build a custom Stagehand logger that filters out the noisy upstream
 * `AI_TypeValidationError` schema-validation spam. The errors come from
 * Stagehand's internal Haiku LLM returning bare integers like "4671"
 * when its Zod schema requires "N-N" format (regex /^\\d+-\\d+$/ at
 * stagehand inference.js:147+240). Each error stack-trace is ~500 bytes
 * of pino I/O — verified at 118 occurrences in run 1781485435455
 * (2026-06-14), totaling ~5-7 min of wasted wall clock.
 *
 * The existing cascade Fix 1B (resolvedAction-null fast-skip) already
 * handles the consequence: when Stagehand returns success=false due to
 * this schema error, attempt 1 short-circuits cleanly and attempt 2
 * (observe-act) runs on a structured target instead. The error log
 * lines are pure noise.
 *
 * Filter is precise — only matches when category is "AISDK error"
 * AND the cause body contains both `AI_TypeValidationError` and
 * `elementId`. Other AISDK errors (rate limits, malformed requests,
 * server errors) pass through unchanged. Site-agnostic — the
 * upstream Stagehand bug is universal across tenants.
 *
 * Returns the callback + a `reportSuppressed` function that the
 * session teardown calls to log the final suppression count, plus a
 * `getSuppressedCount` live accessor so callers can read the running
 * total while a step is still executing — e.g. treating "resolver
 * threw on this step" as evidence a reported-success click was
 * phantom, without waiting for teardown.
 */
export function makeFilteredStagehandLogger(pinoLogger: Logger): {
  callback: (line: StagehandLogLine) => void;
  reportSuppressed: () => void;
  getSuppressedCount: () => number;
} {
  let suppressedCount = 0;
  const callback = (line: StagehandLogLine): void => {
    if (line.category === "AISDK error") {
      const cause = line.auxiliary?.cause?.value ?? "";
      if (cause.includes("AI_TypeValidationError") && cause.includes("elementId")) {
        suppressedCount++;
        return;
      }
    }
    // Forward everything else as today — Stagehand's default logger
    // emits via console; we route through pino for consistency.
    if (line.level === 0) {
      pinoLogger.error({ stagehand: line.category }, line.message);
    } else if (line.level === 1) {
      pinoLogger.info({ stagehand: line.category }, line.message);
    } else {
      pinoLogger.debug({ stagehand: line.category }, line.message);
    }
  };
  const reportSuppressed = (): void => {
    if (suppressedCount > 0) {
      pinoLogger.info(
        `stagehand-logger: suppressed ${suppressedCount} AISDK elementId-regex errors (upstream Stagehand bug; cascade Fix 1B handles consequence)`
      );
    }
  };
  const getSuppressedCount = (): number => suppressedCount;
  return { callback, reportSuppressed, getSuppressedCount };
}

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
 *
 * Non-finding (recorded so it is not re-investigated): a Queue-it virtual-waiting-
 * room interstitial has never blocked a Browserbase run in practice. It gates the
 * HTML/browser path for every locale tried but not the underlying JSON API path,
 * and across the runs observed it simply never appeared. Treat a Queue-it page as
 * a site-path signal (prefer the API), not a Browserbase capability gap.
 */
/**
 * `advancedStealth` opts into Browserbase's Scale Plan stealth profile. When
 * enabled we also force `solveCaptchas: true` (explicit; Browserbase defaults
 * it on) and pin a Windows desktop fingerprint — DataDome-protected sites react
 * significantly better to Windows OS signals than the default mac/linux mix.
 * The combination mirrors a production Stagehand preset validated against such
 * sites, not Browserbase's defaults.
 *
 * `browserbaseSessionCreateParams` forwards caller-supplied Browserbase session
 * create params (`timeout` being the intended knob — seconds, per Browserbase's
 * `SessionCreateParams`). They are spread first so `proxies` and
 * `browserSettings.fingerprint` land after and win — ordering is the only thing
 * keeping those ours, so keep the caller spread above them.
 *
 * `projectId` is dropped from the caller params on top of being re-set below —
 * belt and suspenders. Stagehand resolves it as `overrideProjectId ?? projectId`,
 * so a caller value that reached the spread would beat the top-level one and
 * silently route the session into a different Browserbase project. The re-set
 * already prevents that; the strip is what keeps it prevented if the re-set is
 * ever moved or dropped.
 */
export async function createBrowserbaseBrowserSession(
  opts?: Pick<BrowserSessionOptions, "advancedStealth" | "browserbaseSessionCreateParams">
): Promise<BrowserSession> {
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
  const { projectId: _callerProjectId, ...customSessionParams } =
    opts?.browserbaseSessionCreateParams ?? {};

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

  const {
    callback: stagehandLoggerCallback,
    reportSuppressed: reportSuppressedAisdkErrors,
    getSuppressedCount: getSuppressedAisdkElementIdErrorCount,
  } = makeFilteredStagehandLogger(logger);

  let stagehand: Stagehand | undefined;
  try {
    stagehand = new Stagehand({
      env: "BROWSERBASE",
      apiKey: config.scraper.browserbaseApiKey,
      projectId: config.scraper.browserbaseProjectId,
      browserbaseSessionCreateParams: {
        ...customSessionParams,
        projectId: config.scraper.browserbaseProjectId,
        proxies: useResidentialProxy,
        browserSettings: {
          ...customSessionParams.browserSettings,
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
      // Custom logger to filter AISDK schema-error spam — see
      // makeFilteredStagehandLogger TSDoc for rationale.
      logger: stagehandLoggerCallback,
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
    reportSuppressedAisdkErrors();
  };

  return {
    stagehand,
    limiter,
    sessionId,
    provider: "browserbase",
    close,
    getSuppressedAisdkElementIdErrorCount,
  };
}
