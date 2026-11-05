import Browserbase from "@browserbasehq/sdk";
import { Agent, setGlobalDispatcher } from "undici";

import { config } from "@/config";

/**
 * @browserbasehq/sdk sets an explicit `content-length` header, then hands the
 * request to Node's native fetch. Once undici is loaded in the process its
 * dispatcher handles that fetch, and undici's Request constructor folds the
 * caller-supplied header together with its own computed one into a comma-joined
 * value (e.g. "52, 52"), which fails undici's digit-only validation with
 * `InvalidArgumentError: invalid content-length header`. Dropping the SDK's
 * explicit header lets undici compute it once, itself.
 *
 * Merely importing undici is enough to trigger this — the `setGlobalDispatcher`
 * call below is not what causes it, and removing it would not help. Any entry
 * point that reaches undici (every one that uses `raw-fetch`, so in practice all
 * of them) needs this patch, which is why {@link configureHttpDispatcher} must
 * run in each one and why `./lib/http` is an exported subpath.
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
 * patches around a @browserbasehq/sdk header-collision bug (see above). Must be
 * called once at process startup in every entry point that makes outbound fetch
 * calls — `server.ts`, scripts, probes, batch jobs — including a consumer's own,
 * via `@enricai/barnacle/lib/http`.
 *
 * Skipping it is not a soft failure: the SDK's `sessions.update` call is how a
 * `keepAlive` session is released, so without this patch every session the entry
 * point creates stays `RUNNING` and bills until its own timeout.
 */
export function configureHttpDispatcher(): void {
  setGlobalDispatcher(new Agent({ connect: { timeout: config.scraper.connectTimeoutMs } }));
  patchBrowserbaseContentLengthHeader();
}
