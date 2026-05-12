import type { IncomingMessage, ServerResponse } from "node:http";

import { nanoid } from "nanoid";
import type { HttpLogger } from "pino-http";
import pinoHttp from "pino-http";

import { getHttpLoggerOptions } from "@/lib/logging";

/**
 * Request ID header name for distributed tracing.
 * This header is used to correlate logs across services.
 */
export const REQUEST_ID_HEADER = "x-request-id";

/**
 * Correlation ID header name for cross-service tracing.
 * Use this to track requests across multiple services.
 */
export const CORRELATION_ID_HEADER = "x-correlation-id";

/**
 * Generates a unique request ID using nanoid.
 * Returns a 21-character URL-safe unique identifier.
 *
 * @returns Unique request ID string
 */
export function generateRequestId(): string {
  return nanoid();
}

/**
 * Extracts or generates a request ID from an incoming request.
 * If the request already has an x-request-id header, it will be used.
 * Otherwise, a new ID is generated.
 *
 * @param req - Incoming HTTP request
 * @returns Request ID (existing or newly generated)
 */
export function getRequestId(req: IncomingMessage): string {
  const existingId = req.headers[REQUEST_ID_HEADER];
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
export function getCorrelationId(req: IncomingMessage): string | undefined {
  const correlationId = req.headers[CORRELATION_ID_HEADER];
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
export function createHttpLogger(): HttpLogger {
  const baseOptions = getHttpLoggerOptions();

  return pinoHttp({
    ...baseOptions,
    genReqId: (req: IncomingMessage): string => getRequestId(req),
    customProps: (req: IncomingMessage): Record<string, unknown> => {
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
export function setRequestIdHeader(res: ServerResponse, requestId: string): void {
  if (!res.headersSent) {
    res.setHeader(REQUEST_ID_HEADER, requestId);
  }
}

/**
 * HTTP request context type containing tracing information.
 * Use this interface when passing request context between functions.
 */
export interface HttpRequestContext {
  requestId: string;
  correlationId?: string;
  method: string;
  url: string;
  startTime: number;
}

/**
 * Extracts HTTP request context from an incoming request.
 * Useful for passing context to downstream functions.
 *
 * @param req - Incoming HTTP request
 * @returns HTTP request context object
 */
export function extractRequestContext(req: IncomingMessage): HttpRequestContext {
  return {
    requestId: getRequestId(req),
    correlationId: getCorrelationId(req),
    method: req.method || "UNKNOWN",
    url: req.url || "/",
    startTime: Date.now(),
  };
}
