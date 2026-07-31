import { formatISO } from "date-fns";
import { getReasonPhrase, StatusCodes } from "http-status-codes";

import { ERROR_CODE_DESCRIPTIONS, ERROR_CODES, type ErrorCode } from "@/api/schemas/common";

/**
 * Representation of the error envelope on the wire. Every non-2xx
 * response from Barnacle conforms to this shape so clients can share a
 * single parser across all error types.
 */
interface ApiStatusDetail {
  code: number;
  codeDescription: string;
  detailType: string;
  message: string;
}

interface ApiErrorEnvelope {
  status: {
    httpStatus: string;
    dateTime: string;
    details: ApiStatusDetail[];
  };
}

/**
 * Maps an error code to the HTTP status we return. Status codes come
 * from the `http-status-codes` package (battle-tested, RFC-aligned, used
 * by Express and thousands of production APIs) so we don't maintain our
 * own numeric table.
 *
 * The envelope uses `httpStatus` as a string. Barnacle also sets the actual
 * HTTP status code so modern clients can branch on either.
 */
export function httpStatusForCode(code: ErrorCode): number {
  switch (code) {
    case ERROR_CODES.PARTIAL_CONTENT_SUCCESS:
      return StatusCodes.PARTIAL_CONTENT;
    case ERROR_CODES.AUTHORIZATION_ERROR:
      return StatusCodes.UNAUTHORIZED;
    case ERROR_CODES.DECODING_ERROR:
    case ERROR_CODES.FIELD_VIOLATION:
    case ERROR_CODES.EMPTY_REQUEST:
      return StatusCodes.BAD_REQUEST;
    case ERROR_CODES.RESOURCE_NOT_FOUND:
    case ERROR_CODES.INDEX_NOT_FOUND:
      return StatusCodes.NOT_FOUND;
    case ERROR_CODES.THROTTLED_REQUEST:
      return StatusCodes.TOO_MANY_REQUESTS;
    case ERROR_CODES.TIME_OUT:
      return StatusCodes.GATEWAY_TIMEOUT;
    case ERROR_CODES.EMPTY_RESULTS:
      return StatusCodes.NOT_FOUND;
    case ERROR_CODES.CLIENT_CALL_ERROR:
    case ERROR_CODES.GENERIC_ERROR:
    case ERROR_CODES.EXTRA_DETAIL:
    case ERROR_CODES.SCRAPE_FAILURE:
    case ERROR_CODES.CAPTCHA_ENCOUNTERED:
      return StatusCodes.INTERNAL_SERVER_ERROR;
    default:
      return StatusCodes.INTERNAL_SERVER_ERROR;
  }
}

/**
 * Converts an HTTP status number into the upper-snake-case string used in
 * the response envelope (e.g. 400 → `"BAD_REQUEST"`). Uses `getReasonPhrase`
 * from `http-status-codes`, then uppercases and replaces non-alphanumeric
 * runs with `_` (e.g. `I'm a teapot` → `I_M_A_TEAPOT`).
 */
export function httpStatusString(status: number): string {
  try {
    return getReasonPhrase(status)
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, "_");
  } catch {
    return `HTTP_${status}`;
  }
}

/**
 * Base class for every structured error Barnacle surfaces to clients. Each
 * subclass hard-codes an error code; the plugin-level error handler
 * reads `code` + `message` and builds the envelope.
 */
export class ApiError extends Error {
  public readonly code: ErrorCode;
  public readonly detailType: string;

  constructor(code: ErrorCode, message: string, detailType = "ERROR") {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.detailType = detailType;
  }
}

export class UnauthorizedError extends ApiError {
  constructor(message = "missing or invalid Authorization header") {
    super(ERROR_CODES.AUTHORIZATION_ERROR, message);
  }
}

export class FieldViolationError extends ApiError {
  constructor(message: string) {
    super(ERROR_CODES.FIELD_VIOLATION, message);
  }
}

export class ThrottledRequestError extends ApiError {
  constructor(message = "rate limit exceeded") {
    super(ERROR_CODES.THROTTLED_REQUEST, message);
  }
}

export class ScrapeFailureError extends ApiError {
  constructor(message = "scraper failed to fulfill the request") {
    super(ERROR_CODES.SCRAPE_FAILURE, message);
  }
}

export class CaptchaEncounteredError extends ApiError {
  constructor(message = "captcha challenge encountered upstream") {
    super(ERROR_CODES.CAPTCHA_ENCOUNTERED, message);
  }
}

export class EmptyResultsApiError extends ApiError {
  constructor(message = "scrape completed but returned no results") {
    super(ERROR_CODES.EMPTY_RESULTS, message);
  }
}

/**
 * Builds an error envelope for the given code + message. Used by the
 * Fastify error handler and anywhere else a manual non-200 response needs
 * to be emitted (e.g. Fastify's built-in rate-limit 429).
 */
export function buildErrorEnvelope(
  code: ErrorCode,
  message: string,
  detailType = "ERROR"
): ApiErrorEnvelope {
  const httpStatus = httpStatusForCode(code);
  return {
    status: {
      httpStatus: httpStatusString(httpStatus),
      dateTime: formatISO(new Date()),
      details: [
        {
          code,
          codeDescription: ERROR_CODE_DESCRIPTIONS[code],
          detailType,
          message,
        },
      ],
    },
  };
}
