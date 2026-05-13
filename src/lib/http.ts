import { Agent, setGlobalDispatcher } from "undici";

import { config } from "@/config";

/**
 * Raises undici's TCP connect timeout from its 10 s hardcoded default.
 * Must be called once at process startup in every entry point that makes
 * outbound fetch calls (server.ts, scripts, etc.).
 */
export function configureHttpDispatcher(): void {
  setGlobalDispatcher(new Agent({ connect: { timeout: config.scraper.connectTimeoutMs } }));
}
