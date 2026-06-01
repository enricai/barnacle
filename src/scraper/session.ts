import { config } from "@/config";
import { createBrowserbaseBrowserSession } from "@/scraper/session-browserbase";
import {
  type BrowserSession,
  type ProviderName,
} from "@/scraper/session-shared";
import { createSteelBrowserSession } from "@/scraper/session-steel";

export type { BrowserSession, ProviderName } from "@/scraper/session-shared";

/**
 * Spins up one browser session via the configured provider. Browserbase is the
 * default; Steel is an opt-in fallback.
 *
 * Provider selection (in order of precedence):
 *   1. Explicit `opts.provider` (per-call override; CLI flags forward here)
 *   2. `SCRAPER_PROVIDER` env var resolved at module load into `config.scraper.provider`
 *   3. Hardcoded default ("browserbase")
 */
export async function createBrowserSession(opts?: {
  provider?: ProviderName;
}): Promise<BrowserSession> {
  const provider = opts?.provider ?? config.scraper.provider;
  if (provider === "browserbase") {
    return createBrowserbaseBrowserSession();
  }
  return createSteelBrowserSession();
}
