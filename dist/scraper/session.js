"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createBrowserSession = createBrowserSession;
const stagehand_1 = require("@browserbasehq/stagehand");
const steel_sdk_1 = __importDefault(require("steel-sdk"));
const config_1 = require("@/config");
const logging_1 = require("@/lib/logging");
const throttle_1 = require("@/scraper/throttle");
const logger = (0, logging_1.getLogger)({ name: "scraper/session" });
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
async function createBrowserSession() {
    if (!config_1.config.scraper.steelApiKey) {
        throw new Error("STEEL_API_KEY is required to create a browser session");
    }
    if (!config_1.config.scraper.anthropicApiKey) {
        throw new Error("ANTHROPIC_API_KEY is required for the Stagehand LLM client");
    }
    const steel = new steel_sdk_1.default({ steelAPIKey: config_1.config.scraper.steelApiKey });
    const session = await steel.sessions.create({
        useProxy: config_1.config.scraper.proxyType === "residential",
        solveCaptcha: true,
    });
    const cdpUrl = session.websocketUrl;
    logger.info(`created steel session ${session.id}`);
    const stagehand = new stagehand_1.Stagehand({
        env: "LOCAL",
        modelName: config_1.config.scraper.model,
        modelClientOptions: { apiKey: config_1.config.scraper.anthropicApiKey },
        enableCaching: true,
        localBrowserLaunchOptions: { cdpUrl },
        verbose: 0,
    });
    await stagehand.init();
    const limiter = (0, throttle_1.createSessionLimiter)();
    const close = async () => {
        try {
            await stagehand.close();
        }
        catch (err) {
            logger.warn(`stagehand close failed for session ${session.id}: ${String(err)}`);
        }
        try {
            await steel.sessions.release(session.id);
        }
        catch (err) {
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
//# sourceMappingURL=session.js.map