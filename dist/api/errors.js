"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.GenericError = exports.CaptchaEncounteredError = exports.ScrapeFailureError = exports.TimeoutError = exports.ThrottledRequestError = exports.ResourceNotFoundError = exports.EmptyRequestError = exports.FieldViolationError = exports.UnauthorizedError = exports.VpsError = void 0;
exports.httpStatusForCode = httpStatusForCode;
exports.vpsHttpStatusString = vpsHttpStatusString;
exports.buildVpsEnvelope = buildVpsEnvelope;
const date_fns_1 = require("date-fns");
const common_1 = require("@/api/schemas/common");
/**
 * Maps a VPS error code to the HTTP status we return. The RC spec does
 * not prescribe the mapping (VPS returns 200 with `httpStatus` as a
 * string); Barnacle both sets the HTTP status AND mirrors it in the
 * envelope so modern clients can branch on either.
 */
function httpStatusForCode(code) {
    switch (code) {
        case common_1.VPS_ERROR_CODES.PARTIAL_CONTENT_SUCCESS:
            return 206;
        case common_1.VPS_ERROR_CODES.AUTHORIZATION_ERROR:
            return 401;
        case common_1.VPS_ERROR_CODES.DECODING_ERROR:
        case common_1.VPS_ERROR_CODES.FIELD_VIOLATION:
        case common_1.VPS_ERROR_CODES.EMPTY_REQUEST:
            return 400;
        case common_1.VPS_ERROR_CODES.RESOURCE_NOT_FOUND:
        case common_1.VPS_ERROR_CODES.INDEX_NOT_FOUND:
        case common_1.VPS_ERROR_CODES.SAILING_NOT_FOUND:
            return 404;
        case common_1.VPS_ERROR_CODES.SAILING_SOLD_OUT:
            return 409;
        case common_1.VPS_ERROR_CODES.THROTTLED_REQUEST:
            return 429;
        case common_1.VPS_ERROR_CODES.TIME_OUT:
            return 504;
        case common_1.VPS_ERROR_CODES.CLIENT_CALL_ERROR:
        case common_1.VPS_ERROR_CODES.GENERIC_ERROR:
        case common_1.VPS_ERROR_CODES.EXTRA_DETAIL:
        case common_1.VPS_ERROR_CODES.SCRAPE_FAILURE:
        case common_1.VPS_ERROR_CODES.CAPTCHA_ENCOUNTERED:
            return 500;
        default:
            return 500;
    }
}
/**
 * Maps an HTTP status number to the string form RC uses in the envelope.
 */
function vpsHttpStatusString(status) {
    switch (status) {
        case 200:
            return "OK";
        case 206:
            return "PARTIAL_CONTENT";
        case 400:
            return "BAD_REQUEST";
        case 401:
            return "UNAUTHORIZED";
        case 403:
            return "FORBIDDEN";
        case 404:
            return "NOT_FOUND";
        case 409:
            return "CONFLICT";
        case 429:
            return "TOO_MANY_REQUESTS";
        case 500:
            return "INTERNAL_SERVER_ERROR";
        case 502:
            return "BAD_GATEWAY";
        case 503:
            return "SERVICE_UNAVAILABLE";
        case 504:
            return "GATEWAY_TIMEOUT";
        default:
            return `HTTP_${status}`;
    }
}
/**
 * Base class for every structured error Barnacle surfaces to clients. Each
 * subclass hard-codes a VPS error code; the plugin-level error handler
 * reads `code` + `message` and builds the envelope.
 */
class VpsError extends Error {
    code;
    detailType;
    constructor(code, message, detailType = "ERROR") {
        super(message);
        this.name = new.target.name;
        this.code = code;
        this.detailType = detailType;
    }
}
exports.VpsError = VpsError;
class UnauthorizedError extends VpsError {
    constructor(message = "missing or invalid Authorization header") {
        super(common_1.VPS_ERROR_CODES.AUTHORIZATION_ERROR, message);
    }
}
exports.UnauthorizedError = UnauthorizedError;
class FieldViolationError extends VpsError {
    constructor(message) {
        super(common_1.VPS_ERROR_CODES.FIELD_VIOLATION, message);
    }
}
exports.FieldViolationError = FieldViolationError;
class EmptyRequestError extends VpsError {
    constructor(message = "request body is empty") {
        super(common_1.VPS_ERROR_CODES.EMPTY_REQUEST, message);
    }
}
exports.EmptyRequestError = EmptyRequestError;
class ResourceNotFoundError extends VpsError {
    constructor(message = "resource not found") {
        super(common_1.VPS_ERROR_CODES.RESOURCE_NOT_FOUND, message);
    }
}
exports.ResourceNotFoundError = ResourceNotFoundError;
class ThrottledRequestError extends VpsError {
    constructor(message = "rate limit exceeded") {
        super(common_1.VPS_ERROR_CODES.THROTTLED_REQUEST, message);
    }
}
exports.ThrottledRequestError = ThrottledRequestError;
class TimeoutError extends VpsError {
    constructor(message = "upstream request timed out") {
        super(common_1.VPS_ERROR_CODES.TIME_OUT, message);
    }
}
exports.TimeoutError = TimeoutError;
class ScrapeFailureError extends VpsError {
    constructor(message = "scraper failed to fulfill the request") {
        super(common_1.VPS_ERROR_CODES.SCRAPE_FAILURE, message);
    }
}
exports.ScrapeFailureError = ScrapeFailureError;
class CaptchaEncounteredError extends VpsError {
    constructor(message = "captcha challenge encountered upstream") {
        super(common_1.VPS_ERROR_CODES.CAPTCHA_ENCOUNTERED, message);
    }
}
exports.CaptchaEncounteredError = CaptchaEncounteredError;
class GenericError extends VpsError {
    constructor(message = "internal server error") {
        super(common_1.VPS_ERROR_CODES.GENERIC_ERROR, message);
    }
}
exports.GenericError = GenericError;
/**
 * Builds a VPS error envelope for the given code + message. Used by the
 * Fastify error handler and anywhere else a manual non-200 response needs
 * to be emitted (e.g. Fastify's built-in rate-limit 429).
 */
function buildVpsEnvelope(code, message, detailType = "ERROR") {
    const httpStatus = httpStatusForCode(code);
    return {
        status: {
            httpStatus: vpsHttpStatusString(httpStatus),
            dateTime: (0, date_fns_1.formatISO)(new Date()),
            details: [
                {
                    code,
                    codeDescription: common_1.VPS_ERROR_CODE_DESCRIPTIONS[code],
                    detailType,
                    message,
                },
            ],
        },
    };
}
//# sourceMappingURL=errors.js.map