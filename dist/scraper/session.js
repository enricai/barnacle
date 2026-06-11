"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createBrowserSession = createBrowserSession;
const config_1 = require("../config");
const session_browserbase_1 = require("../scraper/session-browserbase");
const session_steel_1 = require("../scraper/session-steel");
/**
 * Spins up one browser session via the configured provider. Browserbase is the
 * default; Steel is an opt-in fallback.
 *
 * Provider selection (in order of precedence):
 *   1. Explicit `opts.provider` (per-call override; CLI flags forward here)
 *   2. `SCRAPER_PROVIDER` env var resolved at module load into `config.scraper.provider`
 *   3. Hardcoded default ("browserbase")
 *
 * `advancedStealth` opts into Browserbase's Scale Plan stealth profile (uses a
 * stronger fingerprint mitigation pipeline + forces a Windows desktop
 * fingerprint per Browserbase's DataDome guidance). No-op when the provider
 * is Steel — that path uses its own stealth defaults.
 */
async function createBrowserSession(opts) {
    const provider = opts?.provider ?? config_1.config.scraper.provider;
    if (provider === "browserbase") {
        return (0, session_browserbase_1.createBrowserbaseBrowserSession)({ advancedStealth: opts?.advancedStealth });
    }
    return (0, session_steel_1.createSteelBrowserSession)();
}
//# sourceMappingURL=session.js.map