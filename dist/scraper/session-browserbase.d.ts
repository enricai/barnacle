import { type BrowserSession } from "../scraper/session-shared";
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
export declare function createBrowserbaseBrowserSession(opts?: {
    advancedStealth?: boolean;
}): Promise<BrowserSession>;
