import type { Stagehand } from "@browserbasehq/stagehand";
import type Bottleneck from "bottleneck";
/** Allowed provider names. */
export type ProviderName = "browserbase" | "steel";
/**
 * A live browser session paired with the per-session action limiter.
 * Callers MUST call `close()` in a `finally` block so the upstream provider
 * stops billing and the underlying browser process is released.
 */
export interface BrowserSession {
    stagehand: Stagehand;
    limiter: Bottleneck;
    /** Provider-issued session id; useful for log correlation. */
    sessionId: string;
    /** Which provider produced this session — informational, useful for logs. */
    provider: ProviderName;
    close(): Promise<void>;
}
/**
 * Returns a fetch wrapper that aborts after `timeoutMs` milliseconds.
 * Handles the total request timeout for Anthropic API calls; the TCP connect
 * timeout is handled separately via setGlobalDispatcher in server.ts.
 */
export declare function createTimeoutFetch(timeoutMs: number): typeof fetch;
export declare function pickRandomViewport(): {
    width: number;
    height: number;
};
