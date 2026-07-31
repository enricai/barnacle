/**
 * Initializes dd-trace APM when DD_TRACE_ENABLED=true. Loaded via the
 * --import flag before any application module so dd-trace can monkey-patch
 * http/net/dns for auto-instrumentation of Fastify routes and outbound calls.
 */
import tracer from "dd-trace";

import { getBoolEnv, getEnv, getNodeEnv, getNumericEnv } from "@/lib/env";

const traceEnabled = getBoolEnv("DD_TRACE_ENABLED", false);

if (traceEnabled) {
  tracer.init({
    service: getEnv("DD_SERVICE", "barnacle"),
    env: getEnv("DD_ENV", getNodeEnv()),
    version: getEnv("DD_VERSION", "0.1.0"),
    hostname: getEnv("DD_AGENT_HOST", "localhost"),
    port: getNumericEnv("DD_DOGSTATSD_PORT", 8125),
    logInjection: true,
    runtimeMetrics: true,
  });
}

export { tracer };
