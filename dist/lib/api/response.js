"use strict";
/**
 * API response builders for consistent response formatting.
 * Provides factory functions for common HTTP responses.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.successResponse = successResponse;
exports.createdResponse = createdResponse;
exports.noContentResponse = noContentResponse;
exports.validationError = validationError;
exports.badRequestError = badRequestError;
exports.unauthorizedError = unauthorizedError;
exports.forbiddenError = forbiddenError;
exports.botBlockedError = botBlockedError;
exports.notFoundError = notFoundError;
exports.conflictError = conflictError;
exports.unprocessableEntityError = unprocessableEntityError;
exports.rateLimitError = rateLimitError;
exports.internalError = internalError;
exports.throwApiError = throwApiError;
const error_1 = require("./error");
/**
 * Creates a successful JSON response.
 *
 * @param data - The response data
 * @param status - HTTP status code (default: 200)
 * @returns Response object
 */
function successResponse(data, status = 200) {
    return Response.json({ data }, { status });
}
/**
 * Creates a 201 Created response.
 *
 * @param data - The created resource data
 * @returns Response object with 201 status
 */
function createdResponse(data) {
    return successResponse(data, 201);
}
/**
 * Creates a 204 No Content response.
 *
 * @returns Response object with 204 status and no body
 */
function noContentResponse() {
    return new Response(null, { status: 204 });
}
/**
 * Creates a validation error response (400).
 *
 * @param message - Error message
 * @param details - Optional validation details (e.g., field errors)
 * @returns Response object
 */
function validationError(message, details) {
    const body = {
        error: {
            code: error_1.ERROR_CODES.VALIDATION_ERROR,
            message,
            ...(details && { details }),
        },
    };
    return Response.json(body, { status: 400 });
}
/**
 * Creates a bad request error response (400).
 *
 * @param message - Error message
 * @returns Response object
 */
function badRequestError(message) {
    return Response.json({
        error: {
            code: error_1.ERROR_CODES.BAD_REQUEST,
            message,
        },
    }, { status: 400 });
}
/**
 * Creates an unauthorized error response (401).
 *
 * @param message - Error message (default: "Unauthorized")
 * @returns Response object
 */
function unauthorizedError(message = "Unauthorized") {
    return Response.json({
        error: {
            code: error_1.ERROR_CODES.UNAUTHORIZED,
            message,
        },
    }, { status: 401 });
}
/**
 * Creates a forbidden error response (403).
 *
 * @param message - Error message (default: "Forbidden")
 * @returns Response object
 */
function forbiddenError(message = "Forbidden") {
    return Response.json({
        error: {
            code: error_1.ERROR_CODES.FORBIDDEN,
            message,
        },
    }, { status: 403 });
}
/**
 * Creates a bot blocked error response (403).
 *
 * @returns Response object
 */
function botBlockedError() {
    return Response.json({
        error: {
            code: error_1.ERROR_CODES.BOT_BLOCKED,
            message: "Request blocked",
        },
    }, { status: 403 });
}
/**
 * Creates a not found error response (404).
 *
 * @param resource - The resource that was not found (e.g., "User", "Post")
 * @returns Response object
 */
function notFoundError(resource) {
    return Response.json({
        error: {
            code: error_1.ERROR_CODES.NOT_FOUND,
            message: `${resource} not found`,
        },
    }, { status: 404 });
}
/**
 * Creates a conflict error response (409).
 *
 * @param message - Error message
 * @returns Response object
 */
function conflictError(message) {
    return Response.json({
        error: {
            code: error_1.ERROR_CODES.CONFLICT,
            message,
        },
    }, { status: 409 });
}
/**
 * Creates an unprocessable entity error response (422).
 *
 * @param message - Error message
 * @param details - Optional details about what couldn't be processed
 * @returns Response object
 */
function unprocessableEntityError(message, details) {
    return Response.json({
        error: {
            code: error_1.ERROR_CODES.UNPROCESSABLE_ENTITY,
            message,
            ...(details && { details }),
        },
    }, { status: 422 });
}
/**
 * Creates a rate limit exceeded error response (429).
 *
 * @param retryAfter - Seconds until the client can retry
 * @returns Response object with Retry-After header
 */
function rateLimitError(retryAfter) {
    return Response.json({
        error: {
            code: error_1.ERROR_CODES.RATE_LIMIT_EXCEEDED,
            message: "Too many requests",
        },
    }, {
        status: 429,
        headers: {
            "Retry-After": retryAfter.toString(),
        },
    });
}
/**
 * Creates an internal error response (500).
 *
 * @param message - Error message (default: "An internal error occurred")
 * @returns Response object
 */
function internalError(message = "An internal error occurred") {
    return Response.json({
        error: {
            code: error_1.ERROR_CODES.INTERNAL_ERROR,
            message,
        },
    }, { status: 500 });
}
/**
 * Throws an ApiError that can be caught by handleApiError.
 * Use this to throw typed errors from within API routes.
 *
 * @param code - Error code
 * @param message - Error message
 * @param statusCode - HTTP status code
 * @param details - Optional error details
 * @throws ApiError
 */
function throwApiError(code, message, statusCode, details) {
    throw new error_1.ApiError(code, message, statusCode, details);
}
//# sourceMappingURL=response.js.map