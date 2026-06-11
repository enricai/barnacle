"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.statusSchema = exports.ERROR_CODE_DESCRIPTIONS = exports.ERROR_CODES = void 0;
const v4_1 = require("zod/v4");
/**
 * Error code registry and HTTP status envelope schema shared across all
 * API responses. The envelope shape keeps every response — success and
 * error — parseable by a single client-side decoder.
 */
exports.ERROR_CODES = {
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
};
/**
 * Reverse lookup: numeric code → canonical description. Used to render
 * `codeDescription` on the wire.
 */
exports.ERROR_CODE_DESCRIPTIONS = {
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
};
/**
 * HTTP status strings (upper-snake-case) used in the response envelope.
 */
const httpStatusSchema = v4_1.z
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
    .or(v4_1.z.string());
/**
 * Single entry in the `status.details[]` array.
 */
const statusDetailSchema = v4_1.z
    .object({
    code: v4_1.z.number().int(),
    codeDescription: v4_1.z.string(),
    detailType: v4_1.z.string().optional(),
    message: v4_1.z.string().optional(),
})
    .loose();
/**
 * The envelope every response is wrapped in. Success and error responses
 * both carry this status block so clients can share a single parser.
 */
exports.statusSchema = v4_1.z
    .object({
    httpStatus: httpStatusSchema,
    dateTime: v4_1.z.string(),
    details: v4_1.z.array(statusDetailSchema).default([]),
})
    .loose();
//# sourceMappingURL=common.js.map