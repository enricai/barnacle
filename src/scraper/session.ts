import { config } from "@/config";
import { createBrowserbaseBrowserSession } from "@/scraper/session-browserbase";
import type { BrowserSession, BrowserSessionOptions } from "@/scraper/session-shared";
import { createSteelBrowserSession } from "@/scraper/session-steel";

export type {
  BrowserbaseSessionCreateParams,
  BrowserSession,
  BrowserSessionOptions,
  ProviderName,
} from "@/scraper/session-shared";

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
 *
 * `browserbaseSessionCreateParams` forwards extra Browserbase session-create
 * params when the selected provider is Browserbase.
 */
export async function createBrowserSession(opts?: BrowserSessionOptions): Promise<BrowserSession> {
  const provider = opts?.provider ?? config.scraper.provider;
  if (provider === "browserbase") {
    return createBrowserbaseBrowserSession({
      advancedStealth: opts?.advancedStealth,
      browserbaseSessionCreateParams: opts?.browserbaseSessionCreateParams,
    });
  }
  return createSteelBrowserSession();
}
