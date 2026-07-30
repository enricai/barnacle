import Browserbase from "@browserbasehq/sdk";
import { Agent, setGlobalDispatcher } from "undici";

import { config } from "@/config";

/**
 * @browserbasehq/sdk sets an explicit `content-length` header, then hands the
 * request to Node's native fetch. Under the custom global dispatcher installed
 * below, undici's Request constructor folds that caller-supplied header
 * together with its own computed one into a comma-joined value (e.g.
 * "52, 52"), which fails undici's digit-only validation with
 * `InvalidArgumentError: invalid content-length header`. Dropping the SDK's
 * explicit header lets undici compute it once, itself.
 */
function patchBrowserbaseContentLengthHeader(): void {
  const apiClientPrototype = Object.getPrototypeOf(Browserbase.prototype) as {
    buildHeaders: (args: Record<string, unknown>) => Record<string, string>;
  };
  const originalBuildHeaders = apiClientPrototype.buildHeaders;
  apiClientPrototype.buildHeaders = function (
    this: unknown,
    args: Record<string, unknown>
  ): Record<string, string> {
    return originalBuildHeaders.call(this, { ...args, contentLength: null });
  };
}

/**
 * Raises undici's TCP connect timeout from its 10 s hardcoded default, and
 * patches around a @browserbasehq/sdk header-collision bug the custom
 * dispatcher triggers. Must be called once at process startup in every entry
 * point that makes outbound fetch calls (server.ts, scripts, etc.).
 */
export function configureHttpDispatcher(): void {
  setGlobalDispatcher(new Agent({ connect: { timeout: config.scraper.connectTimeoutMs } }));
  patchBrowserbaseContentLengthHeader();
}
