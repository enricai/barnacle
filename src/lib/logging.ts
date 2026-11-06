import { formatISO } from "date-fns";
import pino from "pino";

import { getTracer } from "@/lib/datadog";
import { getBoolEnv, getEnv, getNodeEnv } from "@/lib/env";
import { redactPii, redactPiiDeep } from "@/lib/pii-redaction";
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

// Emit `level` as its uppercase string label rather than pino's numeric default;
// log aggregators (Datadog, CloudWatch Insights) filter on strings, and Datadog's
// `@level:ERROR` attribute match is case-sensitive, so the casing must match the
// other Enric services (the api logs `ERROR`) for one monitor to cover them all.
const formatters = {
  level: (label: string): { level: string } => {
    return { level: label.toUpperCase() };
  },
};

type LogFunction = (obj: unknown, ...args: unknown[]) => void;

/**
 * Scrubs registered request values from every argument before pino formats
 * the line. `redact` only matches object keys; log messages are interpolated
 * strings, so values have to be matched by content. Child loggers (e.g.
 * Fastify's `request.log`) inherit pino hooks. Exported for direct testing.
 */
export const PII_REDACTING_LOG_HOOKS: pino.LoggerOptions["hooks"] = {
  logMethod(args, method): void {
    method.apply(this, args.map((arg) => redactPiiDeep(arg)) as Parameters<typeof method>);
  },
};

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
    // The redaction hook sees one chunk at a time, so a value cut in half by
    // the split would match in neither; scrub the whole message first.
    const whole = splitLargeMessage(obj);
    const chunks = whole.length > 1 ? splitLargeMessage(redactPii(obj)) : whole;
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
 * Wraps a level method so it splits oversized messages, running against the
 * logger it is called on. Child loggers inherit these wrappers, so binding to
 * the logger they were created for would route every child's output through
 * its parent, dropping the child's bindings and serializers (Fastify's
 * `request.log` then dumps the raw request, `rawHeaders` included).
 */
function withSplitting(logger: pino.Logger, original: LogFunction): LogFunction {
  return function (this: pino.Logger | undefined, obj: unknown, ...args: unknown[]): void {
    logWithSplitting(original.bind(this ?? logger), obj, ...args);
  };
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

  extendedLogger.info = withSplitting(logger, extendedLogger.info as LogFunction);
  extendedLogger.error = withSplitting(logger, extendedLogger.error as LogFunction);
  extendedLogger.warn = withSplitting(logger, extendedLogger.warn as LogFunction);
  extendedLogger.debug = withSplitting(logger, extendedLogger.debug as LogFunction);

  extendedLogger.errorWithStack = function (
    this: Logger | undefined,
    error: unknown,
    msg?: string
  ): void {
    const message =
      error instanceof Error
        ? `${msg || error.message}: ${error.stack}`
        : `${msg || JSON.stringify(error)}`;
    (this ?? extendedLogger).error(message);
  };

  return extendedLogger;
}

/**
 * Returns a pino logger for one-shot CLI scripts. Uses pino-pretty in
 * development (where the devDependency is installed) and falls back to raw
 * JSON elsewhere, paralleling `getLogger`'s gating — `pino-pretty` is pruned
 * from production images, so an unconditional transport crashes on module
 * load in prod (see the pino-pretty prod-crash incident).
 */
export function getScriptLogger(name: string): Logger {
  return extendLogger(
    pino({
      name: getLogName(name, defaultAppName),
      level: process.env.LOG_LEVEL ?? "info",
      hooks: PII_REDACTING_LOG_HOOKS,
      transport,
    })
  );
}

/**
 * Caps how many validation issues a serialized error can carry into one log
 * line.
 *
 * A violation of a repeated field produces one issue per element, so a large
 * array yields a correspondingly large error: a 600-entry response measured
 * ~225 KB as a single line, against CloudWatch's 256 KB event cap — which is
 * why such a line arrives split across events and unreadable at exactly the
 * moment it is needed. Ten issues identify the offending field, which is all
 * the log is for; the full set still reaches the error envelope.
 *
 * `issues` are read from the error AND from `cause`, because a
 * `ResponseSerializationError` from `fastify-type-provider-zod` carries the
 * underlying `ZodError` on `cause` rather than exposing `issues` itself.
 *
 * `message` and `stack` are truncated too, not just `issues`: a `ZodError`
 * renders every issue into its own `message` (measured 121.8 KB for 600
 * issues) and the `stack` embeds that same message again, so capping only the
 * issue array still left ~288 KB on the line.
 */
const MAX_LOGGED_ISSUES = 10;
const MAX_LOGGED_TEXT = 2000;

/** Truncates an error's free-text field, noting how much was dropped. */
function capText(value: unknown): unknown {
  if (typeof value !== "string" || value.length <= MAX_LOGGED_TEXT) return value;
  return `${value.slice(0, MAX_LOGGED_TEXT)}… [${value.length - MAX_LOGGED_TEXT} more chars]`;
}

function serializeError(error: unknown): object {
  const err = error as {
    constructor?: { name?: string };
    message?: unknown;
    stack?: unknown;
    statusCode?: unknown;
    code?: unknown;
    issues?: unknown;
    cause?: { issues?: unknown; message?: unknown };
  };
  const base = {
    type: err?.constructor?.name,
    message: capText(err?.message),
    stack: capText(err?.stack),
    ...(err?.statusCode !== undefined && { statusCode: err.statusCode }),
    ...(err?.code !== undefined && { code: err.code }),
  };
  const issues = Array.isArray(err?.issues)
    ? err.issues
    : Array.isArray(err?.cause?.issues)
      ? err.cause.issues
      : undefined;
  if (issues === undefined) {
    return err?.cause?.message === undefined
      ? base
      : { ...base, cause: { message: capText(err.cause.message) } };
  }
  return {
    ...base,
    issues: issues.slice(0, MAX_LOGGED_ISSUES),
    issuesTotal: issues.length,
    ...(issues.length > MAX_LOGGED_ISSUES && {
      issuesTruncated: issues.length - MAX_LOGGED_ISSUES,
    }),
  };
}

/**
 * Pino options for the project's standard logger: pino-pretty transport in
 * dev, JSON in prod, silent in test, secrets redacted, request values scrubbed
 * by hook, and every line tagged with the `DD_SERVICE` service so Datadog does
 * not fall back to its forwarder's account-wide default. Split from `getLogger`
 * so tests can build a non-silent logger with the real redaction wiring.
 */
export function buildLoggerOptions({
  name,
  level,
}: {
  name: string;
  level?: string;
}): pino.LoggerOptions {
  const service = getEnv("DD_SERVICE", "barnacle");
  return {
    name: getLogName(name, defaultAppName),
    level: isTest ? "silent" : level || defaultLoggingLevel,
    base: {
      appName: defaultAppName,
      service,
      env: nodeEnv,
      ...(ddEnabled && {
        dd: {
          service,
          version: getEnv("DD_VERSION", "0.1.0"),
          env: getEnv("DD_ENV", nodeEnv),
        },
      }),
    },
    timestamp: getTimestamp,
    formatters,
    // Child loggers inherit serializers, so this also covers Fastify's
    // `request.log` (the server passes this logger as `loggerInstance`).
    serializers: { err: serializeError },
    hooks: PII_REDACTING_LOG_HOOKS,
    mixin: ddEnabled ? ddMixin : undefined,
    redact: {
      paths: redactPaths,
      censor: "[REDACTED]",
    },
    transport,
  };
}

/**
 * Creates a named pino logger with the project's standard wiring (see
 * {@link buildLoggerOptions}), with every string message auto-chunked under
 * CloudWatch's 256KB event cap. `name` appears as `{appName}://{name}` on every
 * line.
 */
export function getLogger({ name, level }: { name: string; level?: string }): Logger {
  return extendLogger(pino(buildLoggerOptions({ name, level })));
}

function ddMixin(): object {
  const span = getTracer()?.scope().active();
  if (!span) return {};
  const ctx = span.context();
  return { "dd.trace_id": ctx.toTraceId(), "dd.span_id": ctx.toSpanId() };
}
