"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getLogger = getLogger;
exports.createRequestLogger = createRequestLogger;
exports.getLoggerFromFilename = getLoggerFromFilename;
exports.getHttpLoggerOptions = getHttpLoggerOptions;
const node_path_1 = __importDefault(require("node:path"));
const date_fns_1 = require("date-fns");
const pino_1 = __importDefault(require("pino"));
const isDevelopment = process.env.NODE_ENV === "development";
const isTest = process.env.NODE_ENV === "test";
const defaultLoggingLevel = process.env.DEBUG ? "debug" : "info";
const defaultAppName = process.env.APP_NAME || "app";
const basePath = node_path_1.default.join(__dirname, "..");
/**
 * CloudWatch Logs has a hard limit of 256KB per log event.
 * We split messages that exceed this limit to ensure all logs are captured.
 */
const CLOUDWATCH_MAX_LOG_SIZE = 256 * 1024;
const MESSAGE_SPLIT_OVERHEAD = 2 * 1024;
const MAX_MESSAGE_SIZE = CLOUDWATCH_MAX_LOG_SIZE - MESSAGE_SPLIT_OVERHEAD;
const textEncoder = new TextEncoder();
/**
 * Pino 10 transport configuration.
 * Uses pino-pretty in development for readable logs,
 * raw JSON in production for machine parsing.
 * Silent in test environment to avoid log noise.
 */
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
/**
 * Custom timestamp function using ISO 8601 format via date-fns.
 * Provides consistent, timezone-aware timestamps across all environments.
 *
 * @returns Formatted timestamp string for JSON output
 */
function getTimestamp() {
    return `,"time":"${(0, date_fns_1.formatISO)(new Date())}"`;
}
/**
 * Redaction paths for sensitive data.
 * These paths will have their values replaced with "[REDACTED]".
 */
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
/**
 * Custom formatters for Pino 10.
 * Outputs level as string for better observability integration.
 */
const formatters = {
    level: (label) => {
        return { level: label };
    },
};
/**
 * Splits large messages that exceed CloudWatch's 256KB limit.
 * Recursively splits at natural boundaries (newlines, spaces) when possible.
 *
 * @param message - The message to split
 * @param maxSize - Maximum size in bytes (default: MAX_MESSAGE_SIZE)
 * @returns Array of message chunks
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
/**
 * Finds the optimal point to split a message.
 * Prefers splitting at newlines, then spaces, then character boundaries.
 *
 * @param message - The message to find a split point for
 * @param maxSize - Maximum size in bytes
 * @returns Index at which to split the message
 */
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
/**
 * Finds a safe character boundary for splitting UTF-8 encoded text.
 * Ensures we don't split in the middle of a multi-byte character.
 *
 * @param message - The message to find a boundary for
 * @param maxSize - Maximum size in bytes
 * @returns Safe index to split at
 */
function findCharacterBoundary(message, maxSize) {
    let lastSafeIndex = 0;
    let byteCount = 0;
    for (let i = 0; i < message.length; i++) {
        const char = message[i];
        const charCode = char.charCodeAt(0);
        const charSize = charCode < 128 ? 1 : textEncoder.encode(char).length;
        if (byteCount + charSize > maxSize) {
            break;
        }
        byteCount += charSize;
        lastSafeIndex = i + 1;
    }
    return lastSafeIndex || 1;
}
/**
 * Gets the chunk prefix for split messages.
 *
 * @param index - Current chunk index (0-based)
 * @param totalChunks - Total number of chunks
 * @returns Prefix string like "[1/3] " or empty string for single chunks
 */
function getChunkPrefix(index, totalChunks) {
    return totalChunks > 1 ? `[${index + 1}/${totalChunks}] ` : "";
}
/**
 * Wraps a logging function to handle large message splitting.
 *
 * @param originalLogFn - The original Pino log function
 * @param obj - The object or message to log
 * @param args - Additional arguments
 */
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
/**
 * Gets the formatted log name.
 *
 * @param name - Logger name
 * @param appName - Application name
 * @returns Formatted log name
 */
function getLogName(name, appName) {
    return `${appName}://${name}`;
}
/**
 * Extends a pino logger with CloudWatch-aware message splitting and errorWithStack method.
 * Wraps all logging methods to automatically split messages exceeding 256KB.
 *
 * @param logger - Base pino logger
 * @returns Extended logger with message splitting and errorWithStack
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
 * Creates a pino logger instance with modern Pino 10 configuration.
 *
 * Features:
 * - Transport-based pretty printing in development
 * - JSON output in production for log aggregators
 * - Sensitive data redaction (password, token, apiKey, secret)
 * - Level output as string for observability tools
 *
 * @param name - Logger name (e.g., "auth", "database")
 * @param level - Optional log level (default: "info" or "debug" if DEBUG env var is set)
 * @returns Extended Logger instance with errorWithStack method
 */
function getLogger({ name, level }) {
    const options = {
        name: getLogName(name, defaultAppName),
        level: isTest ? "silent" : level || defaultLoggingLevel,
        base: {
            appName: defaultAppName,
            env: process.env.NODE_ENV || "development",
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
/**
 * Creates a child logger with request-specific context.
 * Use this for request tracing and correlation in API handlers.
 *
 * @param parentLogger - The parent logger instance
 * @param context - Request context to attach to all log entries
 * @returns Child logger with context bindings
 * @example
 * ```typescript
 * const logger = getLoggerFromFilename({ filename: __filename });
 * const requestLogger = createRequestLogger(logger, {
 *   requestId: "abc-123",
 *   userId: "user-456",
 *   path: "/api/users",
 *   method: "GET"
 * });
 * requestLogger.info("processing request");
 * // Output includes: requestId, userId, path, method
 * ```
 */
function createRequestLogger(parentLogger, context) {
    return extendLogger(parentLogger.child(context));
}
/**
 * Creates a logger instance from a source filename (__filename).
 * Automatically derives logger name from file path relative to src directory.
 *
 * @param filename - Source file path (use __filename)
 * @param level - Optional log level (default: "info" or "debug" if DEBUG env var is set)
 * @returns Extended Logger instance with errorWithStack method
 * @example
 * ```typescript
 * const logger = getLoggerFromFilename({ filename: __filename });
 * logger.info("message logged");
 * logger.errorWithStack(new Error("failed"), "operation failed");
 * ```
 */
function getLoggerFromFilename({ filename, level = defaultLoggingLevel, }) {
    const fullPath = node_path_1.default.join(node_path_1.default.parse(filename).dir, node_path_1.default.parse(filename).name);
    const name = node_path_1.default.relative(basePath, fullPath);
    return getLogger({ name, level });
}
/**
 * Configuration options for pino-http middleware.
 * Provides consistent logging configuration across HTTP requests.
 *
 * Features:
 * - Request ID generation and tracking
 * - Automatic request/response logging
 * - Sensitive header redaction
 * - Response time measurement
 *
 * @returns pino-http options configured for production use
 * @example
 * ```typescript
 * import pinoHttp from "pino-http";
 * import { getHttpLoggerOptions } from "@/lib/logging";
 *
 * const httpLogger = pinoHttp(getHttpLoggerOptions());
 * ```
 */
function getHttpLoggerOptions() {
    return {
        logger: getLogger({ name: "http" }),
        autoLogging: true,
        customLogLevel: (_req, res, err) => {
            if (res.statusCode >= 500 || err) {
                return "error";
            }
            if (res.statusCode >= 400) {
                return "warn";
            }
            return "info";
        },
        customSuccessMessage: (req, res) => {
            return `${req.method} ${req.url} completed with ${res.statusCode}`;
        },
        customErrorMessage: (_req, res, err) => {
            return `request failed with ${res.statusCode}: ${err?.message || "unknown error"}`;
        },
        customAttributeKeys: {
            req: "request",
            res: "response",
            err: "error",
            responseTime: "duration",
        },
        serializers: {
            req: (req) => ({
                method: req.method,
                url: req.url,
                headers: {
                    "user-agent": req.headers["user-agent"],
                    "content-type": req.headers["content-type"],
                    accept: req.headers.accept,
                },
            }),
            res: (res) => ({
                statusCode: res.statusCode,
            }),
        },
    };
}
//# sourceMappingURL=logging.js.map