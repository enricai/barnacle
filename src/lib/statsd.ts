/**
 * Opt-in DogStatsD client singleton. `hot-shots` is an optional peer dependency:
 * install it and set `DD_METRICS_ENABLED=true` to ship metrics to the Datadog
 * agent. Otherwise every metric call is a no-op, so callers never branch on
 * whether telemetry is configured.
 *
 * `hot-shots` is resolved lazily rather than imported at module scope: this
 * module is reachable from `lib/logging`, and a module-scope import of an
 * optional package would make it a hard requirement for every consumer of the
 * published package.
 */

import { createRequire } from "node:module";

import { getBoolEnv, getEnv, getNodeEnv, getNumericEnv } from "@/lib/env";
import { isModuleNotFound, toErrorMessage } from "@/lib/errors";
import { getLogger } from "@/lib/logging";

const logger = getLogger({ name: "statsd" });

// See `datadog.ts` — same createRequire idiom for resolving an optional peer.
const requirePeer = createRequire(__filename);

/**
 * Structural subset of hot-shots' StatsD that Barnacle uses. Declared locally so
 * the emitted `.d.ts` carries no reference to the optional package — a consumer
 * who skips hot-shots would otherwise hit an unresolvable type import.
 */
export interface StatsDLike {
  increment(stat: string, value?: number, tags?: string[]): void;
  timing(stat: string, value: number, tags?: string[]): void;
  close(callback: (err?: Error) => void): void;
}

type StatsDConstructor = new (options: Record<string, unknown>) => StatsDLike;

/** Discards every metric. Used when metrics are off or hot-shots is absent. */
const noopClient: StatsDLike = {
  increment: () => {},
  timing: () => {},
  close: (callback) => callback(),
};

function createClient(): StatsDLike {
  if (!getBoolEnv("DD_METRICS_ENABLED", false)) {
    logger.debug("metrics disabled (DD_METRICS_ENABLED is off) — statsd calls are no-ops");
    return noopClient;
  }

  const StatsD = loadStatsD();
  if (!StatsD) return noopClient;

  const host = getEnv("DD_AGENT_HOST", "localhost");
  const port = getNumericEnv("DD_DOGSTATSD_PORT", 8125);
  logger.info(`initializing DogStatsD client on ${host}:${port}`);
  return new StatsD({
    host,
    port,
    prefix: "barnacle.",
    globalTags: {
      service: getEnv("DD_SERVICE", "barnacle"),
      env: getEnv("DD_ENV", getNodeEnv()),
    },
    errorHandler: (err: Error) => {
      logger.warn(`statsd send error: ${err.message}`);
    },
  });
}

/**
 * Resolves the hot-shots constructor, or null when it can't be loaded. Only a
 * genuinely absent package earns the "install it" hint — any other failure
 * (corrupt install, native binding error) surfaces its own message, matching how
 * `discover.ts` reports optional-module load failures.
 */
function loadStatsD(): StatsDConstructor | null {
  try {
    const mod = requirePeer("hot-shots") as { default?: StatsDConstructor } & StatsDConstructor;
    return mod.default ?? mod;
  } catch (err) {
    logger.warn(
      isModuleNotFound(err)
        ? "metrics disabled: DD_METRICS_ENABLED is set but hot-shots is not installed. Install it with `pnpm add hot-shots`."
        : `metrics disabled: hot-shots failed to load — ${toErrorMessage(err)}`
    );
    return null;
  }
}

let client: StatsDLike | undefined;

/** Returns the process-global DogStatsD client (lazily initialized). */
export function getStatsD(): StatsDLike {
  if (!client) {
    client = createClient();
  }
  return client;
}

/** Flushes pending packets and closes the UDP socket. Call during shutdown. */
export function shutdownStatsD(): Promise<void> {
  if (!client) {
    return Promise.resolve();
  }
  const c = client;
  return new Promise((resolve, reject) => {
    c.close((err?: Error) => {
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    });
  });
}
