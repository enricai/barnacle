import { formatISO } from "date-fns";
import pino from "pino";

import { tracer } from "@/lib/datadog";
import { getBoolEnv, getEnv, getNodeEnv } from "@/lib/env";
import type { Logger } from "@/types/logging";

const nodeEnv = getNodeEnv();
const isDevelopment = nodeEnv === "development";
const isTest = nodeEnv === "test";
const defaultLoggingLevel = process.env.LOG_LEVEL ?? (process.env.DEBUG ? "debug" : "info");
const defaultAppName = process.env.APP_NAME || "barnacle";
const ddEnabled = getBoolEnv("DD_TRACE_ENABLED", false);

/**
 * CloudWatch Logs has a hard limit of 256KB per log event.
 * We split messages that exceed this limit to ensure all logs are captured.
 */
const CLOUDWATCH_MAX_LOG_SIZE = 256 * 1024;
const MESSAGE_SPLIT_OVERHEAD = 2 * 1024;
const MAX_MESSAGE_SIZE = CLOUDWATCH_MAX_LOG_SIZE - MESSAGE_SPLIT_OVERHEAD;

const textEncoder = new TextEncoder();

const transport = isDevelopment
  ? {
      target: "pino-pretty",
      options: {
        colorize: true,
        translateTime: "SYS:standard",
        ignore: "pid,hostname",
      },
    }
  : undefined;

function getTimestamp(): string {
  return `,"time":"${formatISO(new Date())}"`;
}

const redactPaths = [
  "password",
  "token",
  "apiKey",
  "secret",
  "authorization",
  "cookie",
  "*.password",
  "*.token",
  "*.apiKey",
  "*.secret",
  "*.authorization",
  "req.headers.authorization",
  "req.headers.cookie",
];

// Emit `level` as its string label rather than pino's numeric default;
// log aggregators (Datadog, CloudWatch Insights) filter on strings.
const formatters = {
  level: (label: string): { level: string } => {
    return { level: label };
  },
};

type LogFunction = (obj: unknown, ...args: unknown[]) => void;

/**
 * Splits a message that exceeds CloudWatch's 256KB per-event cap. Prefers
 * newline / space boundaries so chunks stay readable; falls back to a
 * UTF-8-safe byte boundary so we don't slice through a multi-byte char.
 *
 * Exported for direct testing — the runtime emit path runs through a
 * silent pino in NODE_ENV=test, so chunking is otherwise unobservable.
 * Callers outside this module should use the logger methods instead.
 */
export function splitLargeMessage(message: string, maxSize: number = MAX_MESSAGE_SIZE): string[] {
  const messageSize = textEncoder.encode(message).length;

  if (messageSize <= maxSize) {
    return [message];
  }

  const splitPoint = findSplitPoint(message, maxSize);
  const firstChunk = message.slice(0, splitPoint);
  const remainingMessage = message.slice(splitPoint);

  return [firstChunk, ...splitLargeMessage(remainingMessage, maxSize)];
}

function findSplitPoint(message: string, maxSize: number): number {
  const newlineIndex = message.lastIndexOf("\n", maxSize);
  const spaceIndex = message.lastIndexOf(" ", maxSize);

  const halfMax = maxSize / 2;
  if (newlineIndex > halfMax) {
    return newlineIndex + 1;
  }
  if (spaceIndex > halfMax) {
    return spaceIndex + 1;
  }
  return findCharacterBoundary(message, maxSize);
}

function findCharacterBoundary(message: string, maxSize: number): number {
  // Iterate by full code points (not UTF-16 code units) so surrogate
  // pairs stay intact. `message[i]` returns a code unit — for emoji
  // like 🎉 that's the high surrogate alone, which TextEncoder encodes
  // as the 3-byte U+FFFD replacement character. A per-code-unit split
  // could land between the pair and corrupt the character in the log.
  let lastSafeCodeUnitIndex = 0;
  let byteCount = 0;
  let cuIndex = 0;

  for (const char of message) {
    const charCode = char.codePointAt(0) ?? 0;
    const charSize = charCode < 128 ? 1 : textEncoder.encode(char).length;
    if (byteCount + charSize > maxSize) {
      break;
    }
    byteCount += charSize;
    cuIndex += char.length;
    lastSafeCodeUnitIndex = cuIndex;
  }

  return lastSafeCodeUnitIndex || 1;
}

function getChunkPrefix(index: number, totalChunks: number): string {
  return totalChunks > 1 ? `[${index + 1}/${totalChunks}] ` : "";
}

function logWithSplitting(originalLogFn: LogFunction, obj: unknown, ...args: unknown[]): void {
  if (typeof obj === "string") {
    const chunks = splitLargeMessage(obj);
    chunks.forEach((chunk, index) => {
      const prefix = getChunkPrefix(index, chunks.length);
      originalLogFn(`${prefix}${chunk}`, ...args);
    });
  } else {
    originalLogFn(obj, ...args);
  }
}

function getLogName(name: string, appName: string): string {
  return `${appName}://${name}`;
}

/**
 * Wraps a pino logger with the project's extended Logger interface: CloudWatch
 * message splitting on every level method, and `errorWithStack` for one-line
 * error logs that include the stack inline. Used internally by `getLogger` and
 * exported so callers with an existing pino instance (e.g. `request.log`) can
 * promote it to the full Logger contract without creating a new logger.
 */
export function extendLogger(logger: pino.Logger): Logger {
  const extendedLogger = logger as Logger;

  const originalInfo = extendedLogger.info.bind(extendedLogger) as LogFunction;
  const originalError = extendedLogger.error.bind(extendedLogger) as LogFunction;
  const originalWarn = extendedLogger.warn.bind(extendedLogger) as LogFunction;
  const originalDebug = extendedLogger.debug.bind(extendedLogger) as LogFunction;

  extendedLogger.info = (obj: unknown, ...args: unknown[]): void => {
    logWithSplitting(originalInfo, obj, ...args);
  };

  extendedLogger.error = (obj: unknown, ...args: unknown[]): void => {
    logWithSplitting(originalError, obj, ...args);
  };

  extendedLogger.warn = (obj: unknown, ...args: unknown[]): void => {
    logWithSplitting(originalWarn, obj, ...args);
  };

  extendedLogger.debug = (obj: unknown, ...args: unknown[]): void => {
    logWithSplitting(originalDebug, obj, ...args);
  };

  extendedLogger.errorWithStack = (error: unknown, msg?: string): void => {
    const message =
      error instanceof Error
        ? `${msg || error.message}: ${error.stack}`
        : `${msg || JSON.stringify(error)}`;
    logWithSplitting(originalError, message);
  };

  return extendedLogger;
}

/**
 * Returns a pino logger for one-shot CLI scripts. Uses pino-pretty in
 * development (where the devDependency is installed) and falls back to raw
 * JSON elsewhere, mirroring `getLogger`'s gating — `pino-pretty` is pruned
 * from production images, so an unconditional transport crashes on module
 * load in prod (see the pino-pretty prod-crash incident).
 */
export function getScriptLogger(name: string): Logger {
  return extendLogger(
    pino({
      name: getLogName(name, defaultAppName),
      level: process.env.LOG_LEVEL ?? "info",
      transport,
    })
  );
}

/**
 * Creates a named pino logger with the project's standard wiring:
 * pino-pretty transport in dev, JSON in prod, silent in test, secrets
 * redacted, and every string message auto-chunked under CloudWatch's
 * 256KB event cap. `name` appears as `{appName}://{name}` on every line.
 */
export function getLogger({ name, level }: { name: string; level?: string }): Logger {
  const options: pino.LoggerOptions = {
    name: getLogName(name, defaultAppName),
    level: isTest ? "silent" : level || defaultLoggingLevel,
    base: {
      appName: defaultAppName,
      env: nodeEnv,
      ...(ddEnabled && {
        dd: {
          service: getEnv("DD_SERVICE", "barnacle"),
          version: getEnv("DD_VERSION", "0.1.0"),
          env: getEnv("DD_ENV", nodeEnv),
        },
      }),
    },
    timestamp: getTimestamp,
    formatters,
    mixin: ddEnabled ? ddMixin : undefined,
    redact: {
      paths: redactPaths,
      censor: "[REDACTED]",
    },
    transport,
  };

  return extendLogger(pino(options));
}

function ddMixin(): object {
  const span = tracer.scope().active();
  if (!span) return {};
  const ctx = span.context();
  return { "dd.trace_id": ctx.toTraceId(), "dd.span_id": ctx.toSpanId() };
}
