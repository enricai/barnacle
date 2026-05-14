import { formatISO } from "date-fns";
import { getReasonPhrase, StatusCodes } from "http-status-codes";

import {
  VPS_ERROR_CODE_DESCRIPTIONS,
  VPS_ERROR_CODES,
  type VpsErrorCode,
} from "@/api/schemas/common";

/**
 * Representation of the error envelope on the wire. Every non-2xx
 * response from Barnacle conforms to this shape so clients can share a
 * single parser across all error types.
 */
interface VpsStatusDetail {
  code: number;
  codeDescription: string;
  detailType: string;
  message: string;
}

interface VpsErrorEnvelope {
  status: {
    httpStatus: string;
    dateTime: string;
    details: VpsStatusDetail[];
  };
}

/**
 * Maps a VPS error code to the HTTP status we return. Status codes come
 * from the `http-status-codes` package (battle-tested, RFC-aligned, used
 * by Express and thousands of production APIs) so we don't maintain our
 * own numeric table.
 *
 * The envelope uses `httpStatus` as a string. Barnacle also sets the actual
 * HTTP status code so modern clients can branch on either.
 */
export function httpStatusForCode(code: VpsErrorCode): number {
  switch (code) {
    case VPS_ERROR_CODES.PARTIAL_CONTENT_SUCCESS:
      return StatusCodes.PARTIAL_CONTENT;
    case VPS_ERROR_CODES.AUTHORIZATION_ERROR:
      return StatusCodes.UNAUTHORIZED;
    case VPS_ERROR_CODES.DECODING_ERROR:
    case VPS_ERROR_CODES.FIELD_VIOLATION:
    case VPS_ERROR_CODES.EMPTY_REQUEST:
      return StatusCodes.BAD_REQUEST;
    case VPS_ERROR_CODES.RESOURCE_NOT_FOUND:
    case VPS_ERROR_CODES.INDEX_NOT_FOUND:
      return StatusCodes.NOT_FOUND;
    case VPS_ERROR_CODES.THROTTLED_REQUEST:
      return StatusCodes.TOO_MANY_REQUESTS;
    case VPS_ERROR_CODES.TIME_OUT:
      return StatusCodes.GATEWAY_TIMEOUT;
    case VPS_ERROR_CODES.CLIENT_CALL_ERROR:
    case VPS_ERROR_CODES.GENERIC_ERROR:
    case VPS_ERROR_CODES.EXTRA_DETAIL:
    case VPS_ERROR_CODES.SCRAPE_FAILURE:
    case VPS_ERROR_CODES.CAPTCHA_ENCOUNTERED:
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
export function vpsHttpStatusString(status: number): string {
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
 * subclass hard-codes a VPS error code; the plugin-level error handler
 * reads `code` + `message` and builds the envelope.
 */
export class VpsError extends Error {
  public readonly code: VpsErrorCode;
  public readonly detailType: string;

  constructor(code: VpsErrorCode, message: string, detailType = "ERROR") {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.detailType = detailType;
  }
}

export class UnauthorizedError extends VpsError {
  constructor(message = "missing or invalid Authorization header") {
    super(VPS_ERROR_CODES.AUTHORIZATION_ERROR, message);
  }
}

export class FieldViolationError extends VpsError {
  constructor(message: string) {
    super(VPS_ERROR_CODES.FIELD_VIOLATION, message);
  }
}

export class ThrottledRequestError extends VpsError {
  constructor(message = "rate limit exceeded") {
    super(VPS_ERROR_CODES.THROTTLED_REQUEST, message);
  }
}

export class ScrapeFailureError extends VpsError {
  constructor(message = "scraper failed to fulfill the request") {
    super(VPS_ERROR_CODES.SCRAPE_FAILURE, message);
  }
}

export class CaptchaEncounteredError extends VpsError {
  constructor(message = "captcha challenge encountered upstream") {
    super(VPS_ERROR_CODES.CAPTCHA_ENCOUNTERED, message);
  }
}

/**
 * Builds a VPS error envelope for the given code + message. Used by the
 * Fastify error handler and anywhere else a manual non-200 response needs
 * to be emitted (e.g. Fastify's built-in rate-limit 429).
 */
export function buildVpsEnvelope(
  code: VpsErrorCode,
  message: string,
  detailType = "ERROR"
): VpsErrorEnvelope {
  const httpStatus = httpStatusForCode(code);
  return {
    status: {
      httpStatus: vpsHttpStatusString(httpStatus),
      dateTime: formatISO(new Date()),
      details: [
        {
          code,
          codeDescription: VPS_ERROR_CODE_DESCRIPTIONS[code],
          detailType,
          message,
        },
      ],
    },
  };
}
