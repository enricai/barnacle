import { type ErrorCode } from "../api/schemas/common";
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
export declare function httpStatusForCode(code: ErrorCode): number;
/**
 * Converts an HTTP status number into the upper-snake-case string used in
 * the response envelope (e.g. 400 → `"BAD_REQUEST"`). Uses `getReasonPhrase`
 * from `http-status-codes`, then uppercases and replaces non-alphanumeric
 * runs with `_` (e.g. `I'm a teapot` → `I_M_A_TEAPOT`).
 */
export declare function httpStatusString(status: number): string;
/**
 * Base class for every structured error Barnacle surfaces to clients. Each
 * subclass hard-codes an error code; the plugin-level error handler
 * reads `code` + `message` and builds the envelope.
 */
export declare class ApiError extends Error {
    readonly code: ErrorCode;
    readonly detailType: string;
    constructor(code: ErrorCode, message: string, detailType?: string);
}
export declare class UnauthorizedError extends ApiError {
    constructor(message?: string);
}
export declare class FieldViolationError extends ApiError {
    constructor(message: string);
}
export declare class ThrottledRequestError extends ApiError {
    constructor(message?: string);
}
export declare class ScrapeFailureError extends ApiError {
    constructor(message?: string);
}
export declare class CaptchaEncounteredError extends ApiError {
    constructor(message?: string);
}
export declare class EmptyResultsApiError extends ApiError {
    constructor(message?: string);
}
/**
 * Builds an error envelope for the given code + message. Used by the
 * Fastify error handler and anywhere else a manual non-200 response needs
 * to be emitted (e.g. Fastify's built-in rate-limit 429).
 */
export declare function buildErrorEnvelope(code: ErrorCode, message: string, detailType?: string): ApiErrorEnvelope;
export {};
