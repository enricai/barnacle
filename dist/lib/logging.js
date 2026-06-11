"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.splitLargeMessage = splitLargeMessage;
exports.extendLogger = extendLogger;
exports.getScriptLogger = getScriptLogger;
exports.getLogger = getLogger;
const date_fns_1 = require("date-fns");
const pino_1 = __importDefault(require("pino"));
const env_1 = require("../lib/env");
const nodeEnv = (0, env_1.getNodeEnv)();
const isDevelopment = nodeEnv === "development";
const isTest = nodeEnv === "test";
const defaultLoggingLevel = process.env.LOG_LEVEL ?? (process.env.DEBUG ? "debug" : "info");
const defaultAppName = process.env.APP_NAME || "barnacle";
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
function getTimestamp() {
    return `,"time":"${(0, date_fns_1.formatISO)(new Date())}"`;
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
    level: (label) => {
        return { level: label };
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
function splitLargeMessage(message, maxSize = MAX_MESSAGE_SIZE) {
    const messageSize = textEncoder.encode(message).length;
    if (messageSize <= maxSize) {
        return [message];
    }
    const splitPoint = findSplitPoint(message, maxSize);
    const firstChunk = message.slice(0, splitPoint);
    const remainingMessage = message.slice(splitPoint);
    return [firstChunk, ...splitLargeMessage(remainingMessage, maxSize)];
}
function findSplitPoint(message, maxSize) {
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
function findCharacterBoundary(message, maxSize) {
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
function getChunkPrefix(index, totalChunks) {
    return totalChunks > 1 ? `[${index + 1}/${totalChunks}] ` : "";
}
function logWithSplitting(originalLogFn, obj, ...args) {
    if (typeof obj === "string") {
        const chunks = splitLargeMessage(obj);
        chunks.forEach((chunk, index) => {
            const prefix = getChunkPrefix(index, chunks.length);
            originalLogFn(`${prefix}${chunk}`, ...args);
        });
    }
    else {
        originalLogFn(obj, ...args);
    }
}
function getLogName(name, appName) {
    return `${appName}://${name}`;
}
/**
 * Wraps a pino logger with the project's extended Logger interface: CloudWatch
 * message splitting on every level method, and `errorWithStack` for one-line
 * error logs that include the stack inline. Used internally by `getLogger` and
 * exported so callers with an existing pino instance (e.g. `request.log`) can
 * promote it to the full Logger contract without creating a new logger.
 */
function extendLogger(logger) {
    const extendedLogger = logger;
    const originalInfo = extendedLogger.info.bind(extendedLogger);
    const originalError = extendedLogger.error.bind(extendedLogger);
    const originalWarn = extendedLogger.warn.bind(extendedLogger);
    const originalDebug = extendedLogger.debug.bind(extendedLogger);
    extendedLogger.info = (obj, ...args) => {
        logWithSplitting(originalInfo, obj, ...args);
    };
    extendedLogger.error = (obj, ...args) => {
        logWithSplitting(originalError, obj, ...args);
    };
    extendedLogger.warn = (obj, ...args) => {
        logWithSplitting(originalWarn, obj, ...args);
    };
    extendedLogger.debug = (obj, ...args) => {
        logWithSplitting(originalDebug, obj, ...args);
    };
    extendedLogger.errorWithStack = (error, msg) => {
        const message = error instanceof Error
            ? `${msg || error.message}: ${error.stack}`
            : `${msg || JSON.stringify(error)}`;
        logWithSplitting(originalError, message);
    };
    return extendedLogger;
}
/**
 * Returns a pino logger with pino-pretty transport unconditionally — for
 * one-shot CLI scripts where human-readable output is required in all
 * environments. Satisfies CLAUDE.md's "never console" rule without
 * emitting raw JSON that obscures progress output.
 */
function getScriptLogger(name) {
    return extendLogger((0, pino_1.default)({
        name: getLogName(name, defaultAppName),
        level: process.env.LOG_LEVEL ?? "info",
        transport: {
            target: "pino-pretty",
            options: { colorize: true, translateTime: "SYS:standard", ignore: "pid,hostname" },
        },
    }));
}
/**
 * Creates a named pino logger with the project's standard wiring:
 * pino-pretty transport in dev, JSON in prod, silent in test, secrets
 * redacted, and every string message auto-chunked under CloudWatch's
 * 256KB event cap. `name` appears as `{appName}://{name}` on every line.
 */
function getLogger({ name, level }) {
    const options = {
        name: getLogName(name, defaultAppName),
        level: isTest ? "silent" : level || defaultLoggingLevel,
        base: {
            appName: defaultAppName,
            env: nodeEnv,
        },
        timestamp: getTimestamp,
        formatters,
        redact: {
            paths: redactPaths,
            censor: "[REDACTED]",
        },
        transport,
    };
    return extendLogger((0, pino_1.default)(options));
}
//# sourceMappingURL=logging.js.map