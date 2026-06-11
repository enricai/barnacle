"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.EmptyResultsApiError = exports.CaptchaEncounteredError = exports.ScrapeFailureError = exports.ThrottledRequestError = exports.FieldViolationError = exports.UnauthorizedError = exports.ApiError = void 0;
exports.httpStatusForCode = httpStatusForCode;
exports.httpStatusString = httpStatusString;
exports.buildErrorEnvelope = buildErrorEnvelope;
const date_fns_1 = require("date-fns");
const http_status_codes_1 = require("http-status-codes");
const common_1 = require("../api/schemas/common");
/**
 * Maps an error code to the HTTP status we return. Status codes come
 * from the `http-status-codes` package (battle-tested, RFC-aligned, used
 * by Express and thousands of production APIs) so we don't maintain our
 * own numeric table.
 *
 * The envelope uses `httpStatus` as a string. Barnacle also sets the actual
 * HTTP status code so modern clients can branch on either.
 */
function httpStatusForCode(code) {
    switch (code) {
        case common_1.ERROR_CODES.PARTIAL_CONTENT_SUCCESS:
            return http_status_codes_1.StatusCodes.PARTIAL_CONTENT;
        case common_1.ERROR_CODES.AUTHORIZATION_ERROR:
            return http_status_codes_1.StatusCodes.UNAUTHORIZED;
        case common_1.ERROR_CODES.DECODING_ERROR:
        case common_1.ERROR_CODES.FIELD_VIOLATION:
        case common_1.ERROR_CODES.EMPTY_REQUEST:
            return http_status_codes_1.StatusCodes.BAD_REQUEST;
        case common_1.ERROR_CODES.RESOURCE_NOT_FOUND:
        case common_1.ERROR_CODES.INDEX_NOT_FOUND:
            return http_status_codes_1.StatusCodes.NOT_FOUND;
        case common_1.ERROR_CODES.THROTTLED_REQUEST:
            return http_status_codes_1.StatusCodes.TOO_MANY_REQUESTS;
        case common_1.ERROR_CODES.TIME_OUT:
            return http_status_codes_1.StatusCodes.GATEWAY_TIMEOUT;
        case common_1.ERROR_CODES.EMPTY_RESULTS:
            return http_status_codes_1.StatusCodes.NOT_FOUND;
        case common_1.ERROR_CODES.CLIENT_CALL_ERROR:
        case common_1.ERROR_CODES.GENERIC_ERROR:
        case common_1.ERROR_CODES.EXTRA_DETAIL:
        case common_1.ERROR_CODES.SCRAPE_FAILURE:
        case common_1.ERROR_CODES.CAPTCHA_ENCOUNTERED:
            return http_status_codes_1.StatusCodes.INTERNAL_SERVER_ERROR;
        default:
            return http_status_codes_1.StatusCodes.INTERNAL_SERVER_ERROR;
    }
}
/**
 * Converts an HTTP status number into the upper-snake-case string used in
 * the response envelope (e.g. 400 → `"BAD_REQUEST"`). Uses `getReasonPhrase`
 * from `http-status-codes`, then uppercases and replaces non-alphanumeric
 * runs with `_` (e.g. `I'm a teapot` → `I_M_A_TEAPOT`).
 */
function httpStatusString(status) {
    try {
        return (0, http_status_codes_1.getReasonPhrase)(status)
            .toUpperCase()
            .replace(/[^A-Z0-9]+/g, "_");
    }
    catch {
        return `HTTP_${status}`;
    }
}
/**
 * Base class for every structured error Barnacle surfaces to clients. Each
 * subclass hard-codes an error code; the plugin-level error handler
 * reads `code` + `message` and builds the envelope.
 */
class ApiError extends Error {
    code;
    detailType;
    constructor(code, message, detailType = "ERROR") {
        super(message);
        this.name = new.target.name;
        this.code = code;
        this.detailType = detailType;
    }
}
exports.ApiError = ApiError;
class UnauthorizedError extends ApiError {
    constructor(message = "missing or invalid Authorization header") {
        super(common_1.ERROR_CODES.AUTHORIZATION_ERROR, message);
    }
}
exports.UnauthorizedError = UnauthorizedError;
class FieldViolationError extends ApiError {
    constructor(message) {
        super(common_1.ERROR_CODES.FIELD_VIOLATION, message);
    }
}
exports.FieldViolationError = FieldViolationError;
class ThrottledRequestError extends ApiError {
    constructor(message = "rate limit exceeded") {
        super(common_1.ERROR_CODES.THROTTLED_REQUEST, message);
    }
}
exports.ThrottledRequestError = ThrottledRequestError;
class ScrapeFailureError extends ApiError {
    constructor(message = "scraper failed to fulfill the request") {
        super(common_1.ERROR_CODES.SCRAPE_FAILURE, message);
    }
}
exports.ScrapeFailureError = ScrapeFailureError;
class CaptchaEncounteredError extends ApiError {
    constructor(message = "captcha challenge encountered upstream") {
        super(common_1.ERROR_CODES.CAPTCHA_ENCOUNTERED, message);
    }
}
exports.CaptchaEncounteredError = CaptchaEncounteredError;
class EmptyResultsApiError extends ApiError {
    constructor(message = "scrape completed but returned no results") {
        super(common_1.ERROR_CODES.EMPTY_RESULTS, message);
    }
}
exports.EmptyResultsApiError = EmptyResultsApiError;
/**
 * Builds an error envelope for the given code + message. Used by the
 * Fastify error handler and anywhere else a manual non-200 response needs
 * to be emitted (e.g. Fastify's built-in rate-limit 429).
 */
function buildErrorEnvelope(code, message, detailType = "ERROR") {
    const httpStatus = httpStatusForCode(code);
    return {
        status: {
            httpStatus: httpStatusString(httpStatus),
            dateTime: (0, date_fns_1.formatISO)(new Date()),
            details: [
                {
                    code,
                    codeDescription: common_1.ERROR_CODE_DESCRIPTIONS[code],
                    detailType,
                    message,
                },
            ],
        },
    };
}
//# sourceMappingURL=errors.js.map