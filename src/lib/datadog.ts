/**
 * Opt-in dd-trace APM wiring. `dd-trace` is an optional peer dependency: install
 * it and set `DD_TRACE_ENABLED=true` to enable APM. Otherwise Barnacle runs
 * without it and this module resolves to null.
 *
 * The tracer is resolved lazily rather than imported at module scope. Requiring
 * `dd-trace` installs a require-in-the-middle hook that rewrites every
 * subsequent module load; because `lib/logging` reaches this module, a
 * module-scope import pushed that hook into the module graph of anything that
 * logs — including consumers of the published package, where it intercepted
 * `require("vitest")` and forced its CommonJS entry, breaking their test runs.
 *
 * Full auto-instrumentation additionally requires the tracer to load before any
 * other module, via `node --import dd-trace/initialize` (see the `start`
 * script). This module only supplies the `init` configuration and exposes the
 * tracer for log-trace correlation.
 */
import { createRequire } from "node:module";

import { getBoolEnv, getEnv, getNodeEnv, getNumericEnv } from "@/lib/env";
import { isModuleNotFound, toErrorMessage } from "@/lib/errors";

// Matches `discover.ts`'s createRequire idiom for resolving packages at runtime.
// `__filename` is the same both-environments anchor `scraper/fixtures.ts` relies
// on: `src/lib/` under tsx, `dist/lib/` under node — either way the optional
// peer resolves from the installing project's node_modules.
const requirePeer = createRequire(__filename);

/**
 * Structural subset of dd-trace's tracer that this module uses. Declared
 * locally so the emitted `.d.ts` carries no reference to the optional package —
 * a consumer who skips dd-trace would otherwise hit an unresolvable type import.
 */
interface TracerLike {
  init(options: Record<string, unknown>): unknown;
  scope(): {
    active(): {
      context(): { toTraceId(): string; toSpanId(): string };
    } | null;
  };
}

const traceEnabled = getBoolEnv("DD_TRACE_ENABLED", false);

/**
 * Resolves and initializes the tracer, or returns null when APM is off or
 * `dd-trace` is absent. Enabled-but-missing warns instead of throwing: telemetry
 * is opt-in, so its absence must never take the process down.
 */
function loadTracer(): TracerLike | null {
  if (!traceEnabled) return null;

  try {
    const mod = requirePeer("dd-trace") as { default?: TracerLike } & TracerLike;
    const tracer = mod.default ?? mod;
    tracer.init({
      service: getEnv("DD_SERVICE", "barnacle"),
      env: getEnv("DD_ENV", getNodeEnv()),
      version: getEnv("DD_VERSION", "0.1.0"),
      hostname: getEnv("DD_AGENT_HOST", "localhost"),
      port: getNumericEnv("DD_DOGSTATSD_PORT", 8125),
      logInjection: true,
      runtimeMetrics: true,
    });
    return tracer;
  } catch (err) {
    // The project logger imports this module, so warn via process to avoid a cycle.
    // Only a genuinely absent package gets the "install it" hint — any other
    // failure (corrupt install, native binding error) surfaces its own message,
    // matching how `discover.ts` reports optional-module load failures.
    process.emitWarning(
      isModuleNotFound(err)
        ? "APM disabled: DD_TRACE_ENABLED is set but dd-trace is not installed. Install it with `pnpm add dd-trace`."
        : `APM disabled: dd-trace failed to load — ${toErrorMessage(err)}`
    );
    return null;
  }
}

let cached: TracerLike | null | undefined;

/**
 * Active tracer, or null when APM is off or unavailable. Memoized so the
 * require and `init` run at most once.
 */
export function getTracer(): TracerLike | null {
  if (cached === undefined) cached = loadTracer();
  return cached;
}
