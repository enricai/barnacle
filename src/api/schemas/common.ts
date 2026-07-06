import { z } from "zod/v4";

/**
 * Error code registry and HTTP status envelope schema shared across all
 * API responses. The envelope shape keeps every response — success and
 * error — parseable by a single client-side decoder.
 */
export const ERROR_CODES = {
  PARTIAL_CONTENT_SUCCESS: 1000,
  DECODING_ERROR: 1001,
  FIELD_VIOLATION: 1002,
  EMPTY_REQUEST: 1003,
  AUTHORIZATION_ERROR: 1004,
  RESOURCE_NOT_FOUND: 1005,
  INDEX_NOT_FOUND: 1006,
  CLIENT_CALL_ERROR: 1007,
  GENERIC_ERROR: 1008,
  EXTRA_DETAIL: 1009,
  THROTTLED_REQUEST: 1010,
  TIME_OUT: 1011,
  SCRAPE_FAILURE: 2003,
  CAPTCHA_ENCOUNTERED: 2004,
  EMPTY_RESULTS: 2005,
  VERIFICATION_TRIGGER_FAILED: 2006,
  RESUME_INVALID_OTP: 2007,
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

/**
 * Reverse lookup: numeric code → canonical description. Used to render
 * `codeDescription` on the wire.
 */
export const ERROR_CODE_DESCRIPTIONS: Record<ErrorCode, string> = {
  1000: "PARTIAL_CONTENT_SUCCESS",
  1001: "DECODING_ERROR",
  1002: "FIELD_VIOLATION",
  1003: "EMPTY_REQUEST",
  1004: "AUTHORIZATION_ERROR",
  1005: "RESOURCE_NOT_FOUND",
  1006: "INDEX_NOT_FOUND",
  1007: "CLIENT_CALL_ERROR",
  1008: "GENERIC_ERROR",
  1009: "EXTRA_DETAIL",
  1010: "THROTTLED_REQUEST",
  1011: "TIME_OUT",
  2003: "SCRAPE_FAILURE",
  2004: "CAPTCHA_ENCOUNTERED",
  2005: "EMPTY_RESULTS",
  2006: "VERIFICATION_TRIGGER_FAILED",
  2007: "RESUME_INVALID_OTP",
};

/**
 * HTTP status strings (upper-snake-case) used in the response envelope.
 */
const httpStatusSchema = z
  .enum([
    "OK",
    "BAD_REQUEST",
    "UNAUTHORIZED",
    "FORBIDDEN",
    "NOT_FOUND",
    "TOO_MANY_REQUESTS",
    "INTERNAL_SERVER_ERROR",
    "SERVICE_UNAVAILABLE",
    "GATEWAY_TIMEOUT",
  ])
  .or(z.string());

/**
 * Single entry in the `status.details[]` array.
 */
const statusDetailSchema = z
  .object({
    code: z.number().int(),
    codeDescription: z.string(),
    detailType: z.string().optional(),
    message: z.string().optional(),
  })
  .loose();

/**
 * The envelope every response is wrapped in. Success and error responses
 * both carry this status block so clients can share a single parser.
 */
export const statusSchema = z
  .object({
    httpStatus: httpStatusSchema,
    dateTime: z.string(),
    details: z.array(statusDetailSchema).default([]),
  })
  .loose();

/**
 * Response envelope emitted by dispatch when the hot path cannot complete
 * the application because the user must supply additional information (e.g.
 * missing profile fields or an OTP code). Returned as HTTP 200 so clients
 * can parse it without branching on status codes.
 */
export const needsUserInfoResponseSchema = z.object({
  status: statusSchema,
  needsUserInfo: z.literal(true),
  missingFields: z.array(
    z.object({
      field: z.string(),
      question: z.string(),
    })
  ),
  requiresOtp: z.boolean(),
});
