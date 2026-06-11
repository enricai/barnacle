"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createSteelBrowserSession = createSteelBrowserSession;
const stagehand_1 = require("@browserbasehq/stagehand");
const steel_sdk_1 = __importDefault(require("steel-sdk"));
const config_1 = require("../config");
const bedrock_1 = require("../lib/bedrock");
const errors_1 = require("../lib/errors");
const logging_1 = require("../lib/logging");
const session_shared_1 = require("../scraper/session-shared");
const throttle_1 = require("../scraper/throttle");
const logger = (0, logging_1.getLogger)({ name: "scraper/session-steel" });
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
async function createSteelBrowserSession() {
    if (!config_1.config.scraper.steelApiKey) {
        throw new Error("STEEL_API_KEY is required for the steel provider");
    }
    if (!config_1.config.scraper.useBedrock && !config_1.config.scraper.anthropicApiKey) {
        throw new Error("ANTHROPIC_API_KEY is required for the Stagehand LLM client");
    }
    const steel = new steel_sdk_1.default({ steelAPIKey: config_1.config.scraper.steelApiKey });
    const viewport = (0, session_shared_1.pickRandomViewport)();
    const session = await steel.sessions.create({
        timeout: config_1.config.scraper.steelSessionTimeoutMs,
        // Lowercase the env value so SCRAPER_PROXY_TYPE="Residential" /
        // "RESIDENTIAL" don't silently turn the proxy off.
        useProxy: config_1.config.scraper.proxyType.toLowerCase() === "residential",
        solveCaptcha: config_1.config.scraper.solveCaptcha,
        dimensions: viewport,
    });
    // Once `sessions.create` resolves, Steel is billing for the remote session.
    // Any failure between here and a successful return must release the session
    // explicitly — otherwise a Stagehand init crash or Stagehand CDP connection
    // failure leaves a live session burning minutes until Steel's own timeout.
    let stagehand;
    try {
        // Steel's websocketUrl is `wss://connect.steel.dev?sessionId=…`. Stagehand's
        // V3 CDP connector requires the apiKey as a query parameter too — without it
        // the connection returns a 502 before the CDP handshake completes.
        const cdpUrl = session.websocketUrl.includes("apiKey=")
            ? session.websocketUrl
            : `${session.websocketUrl}&apiKey=${encodeURIComponent(config_1.config.scraper.steelApiKey)}`;
        logger.info(`created steel session ${session.id} viewport=${viewport.width}x${viewport.height}`);
        if (config_1.config.scraper.useBedrock) {
            logger.info(`using bedrock model ${config_1.config.bedrock.model} in region ${config_1.config.bedrock.region}`);
        }
        const llmClient = config_1.config.scraper.useBedrock
            ? new stagehand_1.AISdkClient({ model: (0, bedrock_1.createBedrockModel)(config_1.config.bedrock) })
            : undefined;
        stagehand = new stagehand_1.Stagehand({
            env: "LOCAL",
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
            localBrowserLaunchOptions: { cdpUrl },
            verbose: 0,
        });
        await stagehand.init();
    }
    catch (err) {
        // Best-effort cleanup; swallow secondary failures so the original
        // error surfaces to the caller.
        try {
            if (stagehand)
                await stagehand.close();
        }
        catch (closeErr) {
            logger.warn(`stagehand close during failed init: ${(0, errors_1.toErrorMessage)(closeErr)}`);
        }
        try {
            await steel.sessions.release(session.id);
        }
        catch (releaseErr) {
            logger.warn(`steel release during failed init for ${session.id}: ${(0, errors_1.toErrorMessage)(releaseErr)}`);
        }
        throw err;
    }
    const limiter = (0, throttle_1.createSessionLimiter)();
    const close = async () => {
        try {
            await stagehand.close();
        }
        catch (err) {
            logger.warn(`stagehand close failed for session ${session.id}: ${(0, errors_1.toErrorMessage)(err)}`);
        }
        try {
            await steel.sessions.release(session.id);
        }
        catch (err) {
            logger.warn(`steel release failed for session ${session.id}: ${(0, errors_1.toErrorMessage)(err)}`);
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
//# sourceMappingURL=session-steel.js.map