import { z } from "zod/v4";
/**
 * Error code registry and HTTP status envelope schema shared across all
 * API responses. The envelope shape keeps every response — success and
 * error — parseable by a single client-side decoder.
 */
export declare const ERROR_CODES: {
    readonly PARTIAL_CONTENT_SUCCESS: 1000;
    readonly DECODING_ERROR: 1001;
    readonly FIELD_VIOLATION: 1002;
    readonly EMPTY_REQUEST: 1003;
    readonly AUTHORIZATION_ERROR: 1004;
    readonly RESOURCE_NOT_FOUND: 1005;
    readonly INDEX_NOT_FOUND: 1006;
    readonly CLIENT_CALL_ERROR: 1007;
    readonly GENERIC_ERROR: 1008;
    readonly EXTRA_DETAIL: 1009;
    readonly THROTTLED_REQUEST: 1010;
    readonly TIME_OUT: 1011;
    readonly SCRAPE_FAILURE: 2003;
    readonly CAPTCHA_ENCOUNTERED: 2004;
    readonly EMPTY_RESULTS: 2005;
};
export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];
/**
 * Reverse lookup: numeric code → canonical description. Used to render
 * `codeDescription` on the wire.
 */
export declare const ERROR_CODE_DESCRIPTIONS: Record<ErrorCode, string>;
/**
 * The envelope every response is wrapped in. Success and error responses
 * both carry this status block so clients can share a single parser.
 */
export declare const statusSchema: z.ZodObject<{
    httpStatus: z.ZodUnion<[z.ZodEnum<{
        OK: "OK";
        BAD_REQUEST: "BAD_REQUEST";
        UNAUTHORIZED: "UNAUTHORIZED";
        FORBIDDEN: "FORBIDDEN";
        NOT_FOUND: "NOT_FOUND";
        TOO_MANY_REQUESTS: "TOO_MANY_REQUESTS";
        INTERNAL_SERVER_ERROR: "INTERNAL_SERVER_ERROR";
        SERVICE_UNAVAILABLE: "SERVICE_UNAVAILABLE";
        GATEWAY_TIMEOUT: "GATEWAY_TIMEOUT";
    }>, z.ZodString]>;
    dateTime: z.ZodString;
    details: z.ZodDefault<z.ZodArray<z.ZodObject<{
        code: z.ZodNumber;
        codeDescription: z.ZodString;
        detailType: z.ZodOptional<z.ZodString>;
        message: z.ZodOptional<z.ZodString>;
    }, z.core.$loose>>>;
}, z.core.$loose>;
