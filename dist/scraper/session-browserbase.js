"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createBrowserbaseBrowserSession = createBrowserbaseBrowserSession;
const stagehand_1 = require("@browserbasehq/stagehand");
const config_1 = require("../config");
const bedrock_1 = require("../lib/bedrock");
const errors_1 = require("../lib/errors");
const logging_1 = require("../lib/logging");
const session_shared_1 = require("../scraper/session-shared");
const throttle_1 = require("../scraper/throttle");
const logger = (0, logging_1.getLogger)({ name: "scraper/session-browserbase" });
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
async function createBrowserbaseBrowserSession(opts) {
    if (!config_1.config.scraper.browserbaseApiKey) {
        throw new Error("BROWSERBASE_API_KEY is required for the browserbase provider");
    }
    if (!config_1.config.scraper.browserbaseProjectId) {
        throw new Error("BROWSERBASE_PROJECT_ID is required for the browserbase provider");
    }
    if (!config_1.config.scraper.useBedrock && !config_1.config.scraper.anthropicApiKey) {
        throw new Error("ANTHROPIC_API_KEY is required for the Stagehand LLM client");
    }
    const viewport = (0, session_shared_1.pickRandomViewport)();
    const useResidentialProxy = config_1.config.scraper.proxyType.toLowerCase() === "residential";
    const advancedStealth = opts?.advancedStealth === true;
    if (config_1.config.scraper.useBedrock) {
        logger.info(`using bedrock model ${config_1.config.bedrock.model} in region ${config_1.config.bedrock.region}`);
    }
    const llmClient = config_1.config.scraper.useBedrock
        ? new stagehand_1.AISdkClient({ model: (0, bedrock_1.createBedrockModel)(config_1.config.bedrock) })
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
            devices: ["desktop"],
            operatingSystems: ["windows"],
        }
        : baseFingerprint;
    let stagehand;
    try {
        stagehand = new stagehand_1.Stagehand({
            env: "BROWSERBASE",
            apiKey: config_1.config.scraper.browserbaseApiKey,
            projectId: config_1.config.scraper.browserbaseProjectId,
            browserbaseSessionCreateParams: {
                projectId: config_1.config.scraper.browserbaseProjectId,
                proxies: useResidentialProxy,
                browserSettings: {
                    ...(advancedStealth ? { advancedStealth: true, solveCaptchas: true } : {}),
                    fingerprint,
                },
            },
            model: config_1.config.scraper.useBedrock
                ? undefined
                : {
                    modelName: config_1.config.scraper.model,
                    apiKey: config_1.config.scraper.anthropicApiKey,
                    // @ai-sdk/anthropic has no `timeout` option; inject timeout at the fetch layer.
                    fetch: (0, session_shared_1.createTimeoutFetch)(config_1.config.scraper.anthropicTimeoutMs),
                },
            llmClient,
            serverCache: true,
            selfHeal: false,
            verbose: 0,
        });
        await stagehand.init();
    }
    catch (err) {
        try {
            if (stagehand)
                await stagehand.close();
        }
        catch (closeErr) {
            logger.warn(`stagehand close during failed init: ${(0, errors_1.toErrorMessage)(closeErr)}`);
        }
        throw err;
    }
    const sessionId = stagehand.browserbaseSessionID ?? "unknown";
    logger.info(`created browserbase session ${sessionId} viewport=${viewport.width}x${viewport.height} proxies=${useResidentialProxy} advancedStealth=${advancedStealth}`);
    const limiter = (0, throttle_1.createSessionLimiter)();
    const close = async () => {
        try {
            await stagehand.close();
        }
        catch (err) {
            logger.warn(`stagehand close failed for session ${sessionId}: ${(0, errors_1.toErrorMessage)(err)}`);
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
//# sourceMappingURL=session-browserbase.js.map