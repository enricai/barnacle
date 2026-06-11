import { type BrowserSession } from "../scraper/session-shared";
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
export declare function createSteelBrowserSession(): Promise<BrowserSession>;
