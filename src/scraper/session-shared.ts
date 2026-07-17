import type { Stagehand } from "@browserbasehq/stagehand";
import type Bottleneck from "bottleneck";

import { pickRandom } from "@/lib/random";

/** Allowed provider names. */
export type ProviderName = "browserbase" | "steel";

/**
 * Extra Browserbase session-create parameters forwarded through Stagehand.
 *
 * Barnacle still owns provider invariants like `projectId`, proxy selection,
 * and fingerprinting; callers use this for bounded Browserbase knobs such as
 * `timeout`.
 */
export type BrowserbaseSessionCreateParams = Record<string, unknown> & {
  browserSettings?: Record<string, unknown>;
};

/** Options accepted by the browser-session factory. */
export interface BrowserSessionOptions {
  provider?: ProviderName;
  advancedStealth?: boolean;
  browserbaseSessionCreateParams?: BrowserbaseSessionCreateParams;
}

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
export function createTimeoutFetch(timeoutMs: number): typeof fetch {
  return (url, init) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    // Merge with any existing signal from the caller (e.g. AI SDK's own abort signal)
    // so both can independently cancel the request.
    const signals = [controller.signal, init?.signal].filter(
      (s): s is AbortSignal => s instanceof AbortSignal
    );
    const signal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];
    return fetch(url, { ...init, signal }).finally(() => clearTimeout(timer));
  };
}

/**
 * Common desktop viewports rotated per session to reduce bot-detection
 * fingerprinting — a fixed pixel size is an easy signal to filter on.
 */
const VIEWPORTS = [
  { width: 1280, height: 720 },
  { width: 1366, height: 768 },
  { width: 1440, height: 900 },
  { width: 1920, height: 1080 },
] as const;

export function pickRandomViewport(): { width: number; height: number } {
  return pickRandom(VIEWPORTS);
}
