import type { BrowserSession, ProviderName } from "../scraper/session-shared";
export type { BrowserSession, ProviderName } from "../scraper/session-shared";
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
export declare function createBrowserSession(opts?: {
    provider?: ProviderName;
    advancedStealth?: boolean;
}): Promise<BrowserSession>;
