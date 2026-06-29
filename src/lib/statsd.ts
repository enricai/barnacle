/**
 * DogStatsD client singleton following Vivian's hot-shots pattern. Sends
 * metrics to the Datadog agent when DD_TRACE_ENABLED=true; falls back to a
 * mock client that logs at debug level for local dev without an agent.
 */

import type { StatsD as StatsDInstance } from "hot-shots";
import StatsD from "hot-shots";

import { getBoolEnv, getEnv, getNumericEnv } from "@/lib/env";
import { getLogger } from "@/lib/logging";

const logger = getLogger({ name: "statsd" });

function createClient(): StatsDInstance {
  const traceEnabled = getBoolEnv("DD_TRACE_ENABLED", false);

  if (traceEnabled) {
    const host = getEnv("DD_AGENT_HOST", "localhost");
    const port = getNumericEnv("DD_DOGSTATSD_PORT", 8125);
    logger.info(`initializing DogStatsD client on ${host}:${port}`);
    return new StatsD({
      host,
      port,
      prefix: "barnacle.",
      globalTags: {
        service: getEnv("DD_SERVICE", "barnacle"),
        env: getEnv("DD_ENV", "development"),
      },
      errorHandler: (err: Error) => {
        logger.warn(`statsd send error: ${err.message}`);
      },
    });
  }

  logger.debug("initializing mock DogStatsD client (DD_TRACE_ENABLED is off)");
  return new StatsD({
    mock: true,
    prefix: "barnacle.",
    globalTags: { service: "barnacle", env: "development" },
  });
}

let client: StatsDInstance | undefined;

/** Returns the process-global DogStatsD client (lazily initialized). */
export function getStatsD(): StatsDInstance {
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
    c.close((err: Error | undefined) => {
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    });
  });
}
