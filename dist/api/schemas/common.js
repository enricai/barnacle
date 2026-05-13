"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.dateTimeRangeSchema = exports.sailingKeySchema = exports.flexibleSailDateSchema = exports.pricingPreferenceSchema = exports.occupancySchema = exports.bookingTypeCodeSchema = exports.marketIdentifierSchema = exports.clientIdentifierSchema = exports.isoDateTimeSchema = exports.numericDateTimeSchema = exports.sailDateStringSchema = exports.brandCodeSchema = exports.vpsStatusSchema = exports.statusDetailSchema = exports.vpsHttpStatusSchema = exports.VPS_ERROR_CODE_DESCRIPTIONS = exports.VPS_ERROR_CODES = void 0;
exports.withVpsEnvelope = withVpsEnvelope;
const zod_1 = require("zod");
/**
 * VPS error codes. Barnacle mirrors RC's catalog (1000-1011 for generic
 * failures, 2XXX for domain-specific ones) and extends it with two scraper-
 * specific codes so clients can distinguish a scrape failure from an upstream
 * RC failure.
 *
 * @see `RC_API_Docs/VPS Onboarding Specification - v1.9.pdf` §Error Handling
 */
exports.VPS_ERROR_CODES = {
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
    SAILING_SOLD_OUT: 2001,
    SAILING_NOT_FOUND: 2002,
    SCRAPE_FAILURE: 2003,
    CAPTCHA_ENCOUNTERED: 2004,
};
/**
 * Reverse lookup: numeric code → canonical description. Used to render
 * `codeDescription` on the wire.
 */
exports.VPS_ERROR_CODE_DESCRIPTIONS = {
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
    2001: "SAILING_SOLD_OUT",
    2002: "SAILING_NOT_FOUND",
    2003: "SCRAPE_FAILURE",
    2004: "CAPTCHA_ENCOUNTERED",
};
/**
 * VPS HTTP status strings (upper-snake-case variant RC uses on the wire).
 */
exports.vpsHttpStatusSchema = zod_1.z
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
    .or(zod_1.z.string());
/**
 * Single entry in the `status.details[]` array. RC is lenient about extra
 * fields; the only ones always present are `code` + `codeDescription`.
 */
exports.statusDetailSchema = zod_1.z
    .object({
    code: zod_1.z.number().int(),
    codeDescription: zod_1.z.string(),
    detailType: zod_1.z.string().optional(),
    message: zod_1.z.string().optional(),
})
    .passthrough();
/**
 * The envelope RC wraps every response in. Responses from Barnacle are
 * required to match this shape exactly so clients can reuse their VPS
 * parsers without modification.
 */
exports.vpsStatusSchema = zod_1.z
    .object({
    httpStatus: exports.vpsHttpStatusSchema,
    dateTime: zod_1.z.string(),
    details: zod_1.z.array(exports.statusDetailSchema).default([]),
})
    .passthrough();
/**
 * Helper that wraps any domain schema in the standard VPS envelope (a top-
 * level `status` object merged with the domain payload).
 */
function withVpsEnvelope(payload) {
    return zod_1.z.intersection(zod_1.z.object({ status: exports.vpsStatusSchema }), payload);
}
/**
 * Brand codes RC supports. `R` = Royal Caribbean International, `C` =
 * Celebrity Cruises. We parse any single-letter string to stay lenient if
 * RC adds a new brand.
 */
exports.brandCodeSchema = zod_1.z.union([zod_1.z.literal("R"), zod_1.z.literal("C"), zod_1.z.string().length(1)]);
/**
 * Sail-date string. RC uses `YYYY-MM-DD` in catalog responses and `YYYYMMDD`
 * (numeric) in delta responses, so we accept both.
 */
exports.sailDateStringSchema = zod_1.z.string().regex(/^(\d{4}-\d{2}-\d{2}|\d{8})$/);
/**
 * Timestamp as a numeric `YYYYMMDDHHMMSS`. RC uses this in promotion-details.
 * Max year is `9999` (sentinel value `99991231235959` indicates "open-ended").
 */
exports.numericDateTimeSchema = zod_1.z.number().int().min(10000101000000).max(99991231235959);
/**
 * ISO-8601 timestamp with optional nanoseconds, as produced by RC in the
 * status envelope. We don't try to parse to Date — string round-tripping is
 * sufficient for parity.
 */
exports.isoDateTimeSchema = zod_1.z.string().min(10);
/**
 * Inbound identifier for an agency (client-scoped queries).
 */
exports.clientIdentifierSchema = zod_1.z
    .object({
    agencyId: zod_1.z.string(),
    currencyCodes: zod_1.z.array(zod_1.z.string()).nonempty(),
    clientId: zod_1.z.string().optional(),
    companyShortName: zod_1.z.string().optional(),
})
    .passthrough();
/**
 * Inbound identifier for a market (market-scoped queries — used when an
 * agencyId is not available).
 */
exports.marketIdentifierSchema = zod_1.z
    .object({
    officeCode: zod_1.z.string(),
    countryCode: zod_1.z.string(),
    currencyCodes: zod_1.z.array(zod_1.z.string()).nonempty(),
})
    .passthrough();
/**
 * Booking-type codes: I = individual, G = group.
 */
exports.bookingTypeCodeSchema = zod_1.z.union([
    zod_1.z.literal("I"),
    zod_1.z.literal("G"),
    zod_1.z.string().length(1),
]);
/**
 * Occupancy integer — RC supports 1 through 4 guests per stateroom in VPS.
 */
exports.occupancySchema = zod_1.z.number().int().min(1).max(8);
/**
 * Pricing preference block shared by all three pricing endpoints.
 */
exports.pricingPreferenceSchema = zod_1.z
    .object({
    depositFareType: zod_1.z
        .union([zod_1.z.literal("BOTH"), zod_1.z.literal("REF"), zod_1.z.literal("NON_REF"), zod_1.z.string()])
        .optional(),
    includeGuestLevelDetail: zod_1.z.boolean().optional(),
    includeGratuity: zod_1.z.boolean().optional(),
})
    .passthrough();
/**
 * Flexible sail-date that accepts either `YYYY-MM-DD` (catalog responses)
 * or a `YYYYMMDD` integer (delta responses).
 */
exports.flexibleSailDateSchema = zod_1.z.union([exports.sailDateStringSchema, zod_1.z.number().int()]);
/**
 * A single sailing identity tuple (shipCode, sailDate, packageCode). Used
 * as keys in the delta endpoints. `sailDate` is numeric on the wire for
 * delta responses and string for catalog responses.
 */
exports.sailingKeySchema = zod_1.z
    .object({
    brandCode: exports.brandCodeSchema.optional(),
    shipCode: zod_1.z.string(),
    sailDate: exports.flexibleSailDateSchema,
    packageCode: zod_1.z.string(),
})
    .passthrough();
/**
 * Date-time range RC echoes back in the delta responses to confirm which
 * window was actually processed (it may clip against server-side bounds).
 */
exports.dateTimeRangeSchema = zod_1.z
    .object({
    fromDateTime: zod_1.z.string(),
    toDateTime: zod_1.z.string(),
})
    .passthrough();
//# sourceMappingURL=common.js.map