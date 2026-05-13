"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.CORRELATION_ID_HEADER = exports.REQUEST_ID_HEADER = void 0;
exports.generateRequestId = generateRequestId;
exports.getRequestId = getRequestId;
exports.getCorrelationId = getCorrelationId;
exports.createHttpLogger = createHttpLogger;
exports.setRequestIdHeader = setRequestIdHeader;
exports.extractRequestContext = extractRequestContext;
const nanoid_1 = require("nanoid");
const pino_http_1 = __importDefault(require("pino-http"));
const logging_1 = require("@/lib/logging");
/**
 * Request ID header name for distributed tracing.
 * This header is used to correlate logs across services.
 */
exports.REQUEST_ID_HEADER = "x-request-id";
/**
 * Correlation ID header name for cross-service tracing.
 * Use this to track requests across multiple services.
 */
exports.CORRELATION_ID_HEADER = "x-correlation-id";
/**
 * Generates a unique request ID using nanoid.
 * Returns a 21-character URL-safe unique identifier.
 *
 * @returns Unique request ID string
 */
function generateRequestId() {
    return (0, nanoid_1.nanoid)();
}
/**
 * Extracts or generates a request ID from an incoming request.
 * If the request already has an x-request-id header, it will be used.
 * Otherwise, a new ID is generated.
 *
 * @param req - Incoming HTTP request
 * @returns Request ID (existing or newly generated)
 */
function getRequestId(req) {
    const existingId = req.headers[exports.REQUEST_ID_HEADER];
    if (typeof existingId === "string" && existingId.length > 0) {
        return existingId;
    }
    return generateRequestId();
}
/**
 * Extracts correlation ID from an incoming request.
 * Returns undefined if no correlation ID is present.
 *
 * @param req - Incoming HTTP request
 * @returns Correlation ID or undefined
 */
function getCorrelationId(req) {
    const correlationId = req.headers[exports.CORRELATION_ID_HEADER];
    if (typeof correlationId === "string" && correlationId.length > 0) {
        return correlationId;
    }
    return undefined;
}
/**
 * Creates a pino-http logger instance with request ID generation.
 * This logger automatically:
 * - Generates request IDs for each request
 * - Logs request/response details
 * - Measures response time
 * - Redacts sensitive headers
 *
 * @returns Configured pino-http logger instance
 * @example
 * ```typescript
 * // In Next.js API route or middleware
 * import { createHttpLogger } from "@/lib/http/middleware";
 *
 * const httpLogger = createHttpLogger();
 *
 * export async function middleware(req, res) {
 *   httpLogger(req, res);
 *   // req.id now contains the request ID
 *   // req.log is available for logging within the request context
 * }
 * ```
 */
function createHttpLogger() {
    const baseOptions = (0, logging_1.getHttpLoggerOptions)();
    return (0, pino_http_1.default)({
        ...baseOptions,
        genReqId: (req) => getRequestId(req),
        customProps: (req) => {
            const correlationId = getCorrelationId(req);
            return correlationId ? { correlationId } : {};
        },
    });
}
/**
 * Sets the request ID header on an outgoing response.
 * Call this to ensure the request ID is returned to the client.
 *
 * @param res - Outgoing HTTP response
 * @param requestId - Request ID to set
 */
function setRequestIdHeader(res, requestId) {
    if (!res.headersSent) {
        res.setHeader(exports.REQUEST_ID_HEADER, requestId);
    }
}
/**
 * Extracts HTTP request context from an incoming request.
 * Useful for passing context to downstream functions.
 *
 * @param req - Incoming HTTP request
 * @returns HTTP request context object
 */
function extractRequestContext(req) {
    return {
        requestId: getRequestId(req),
        correlationId: getCorrelationId(req),
        method: req.method || "UNKNOWN",
        url: req.url || "/",
        startTime: Date.now(),
    };
}
//# sourceMappingURL=middleware.js.map