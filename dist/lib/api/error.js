"use strict";
/**
 * API error codes and error handling utilities.
 * Provides consistent error handling across all API routes.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.ApiError = exports.ERROR_CODES = void 0;
exports.getErrorMessage = getErrorMessage;
exports.isJsonParseError = isJsonParseError;
exports.isApiError = isApiError;
exports.handleApiError = handleApiError;
/**
 * Standardized error codes for API responses.
 * Use these codes to categorize errors for client handling.
 */
exports.ERROR_CODES = {
    VALIDATION_ERROR: "VALIDATION_ERROR",
    NOT_FOUND: "NOT_FOUND",
    RATE_LIMIT_EXCEEDED: "RATE_LIMIT_EXCEEDED",
    INTERNAL_ERROR: "INTERNAL_ERROR",
    BOT_BLOCKED: "BOT_BLOCKED",
    UNAUTHORIZED: "UNAUTHORIZED",
    FORBIDDEN: "FORBIDDEN",
    BAD_REQUEST: "BAD_REQUEST",
    CONFLICT: "CONFLICT",
    UNPROCESSABLE_ENTITY: "UNPROCESSABLE_ENTITY",
};
/**
 * Custom API error class for consistent error handling.
 */
class ApiError extends Error {
    code;
    statusCode;
    details;
    constructor(code, message, statusCode, details) {
        super(message);
        this.name = "ApiError";
        this.code = code;
        this.statusCode = statusCode;
        this.details = details;
    }
    /**
     * Converts the error to a JSON response format.
     */
    toJson() {
        return {
            error: {
                code: this.code,
                message: this.message,
                ...(this.details && { details: this.details }),
            },
        };
    }
}
exports.ApiError = ApiError;
/**
 * Safely extracts an error message from an unknown error.
 *
 * @param error - The error to extract a message from
 * @returns The error message string
 */
function getErrorMessage(error) {
    if (error instanceof Error) {
        return error.message;
    }
    if (typeof error === "string") {
        return error;
    }
    return "An unknown error occurred";
}
/**
 * Checks if an error is a JSON parse error.
 *
 * @param error - The error to check
 * @returns True if the error is a JSON parse error
 */
function isJsonParseError(error) {
    if (error instanceof SyntaxError) {
        return error.message.includes("JSON");
    }
    return false;
}
/**
 * Checks if an error is an ApiError.
 *
 * @param error - The error to check
 * @returns True if the error is an ApiError
 */
function isApiError(error) {
    return error instanceof ApiError;
}
/**
 * Handles API errors consistently, logging and returning appropriate responses.
 *
 * @param error - The error that occurred
 * @param logger - Logger instance for error logging
 * @param context - Optional context information
 * @returns Response object with appropriate status and body
 */
function handleApiError(error, logger, context) {
    const contextStr = context ? ` (${JSON.stringify(context)})` : "";
    if (isApiError(error)) {
        logger.warn(`api error: ${error.code} - ${error.message}${contextStr}`);
        return Response.json(error.toJson(), { status: error.statusCode });
    }
    if (isJsonParseError(error)) {
        logger.warn(`json parse error: ${getErrorMessage(error)}${contextStr}`);
        return Response.json({
            error: {
                code: exports.ERROR_CODES.BAD_REQUEST,
                message: "Invalid JSON in request body",
            },
        }, { status: 400 });
    }
    logger.errorWithStack(error, `unhandled api error${contextStr}`);
    return Response.json({
        error: {
            code: exports.ERROR_CODES.INTERNAL_ERROR,
            message: "An internal error occurred",
        },
    }, { status: 500 });
}
//# sourceMappingURL=error.js.map