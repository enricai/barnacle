import { z } from "zod";

/**
 * VPS error codes. Barnacle mirrors RC's catalog (1000-1011 for generic
 * failures, 2XXX for domain-specific ones) and extends it with two scraper-
 * specific codes so clients can distinguish a scrape failure from an upstream
 * RC failure.
 *
 * @see `RC_API_Docs/VPS Onboarding Specification - v1.9.pdf` §Error Handling
 */
export const VPS_ERROR_CODES = {
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
} as const;

export type VpsErrorCode = (typeof VPS_ERROR_CODES)[keyof typeof VPS_ERROR_CODES];

/**
 * Reverse lookup: numeric code → canonical description. Used to render
 * `codeDescription` on the wire.
 */
export const VPS_ERROR_CODE_DESCRIPTIONS: Record<VpsErrorCode, string> = {
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
export const vpsHttpStatusSchema = z
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
 * Single entry in the `status.details[]` array. RC is lenient about extra
 * fields; the only ones always present are `code` + `codeDescription`.
 */
export const statusDetailSchema = z
  .object({
    code: z.number().int(),
    codeDescription: z.string(),
    detailType: z.string().optional(),
    message: z.string().optional(),
  })
  .passthrough();

/**
 * The envelope RC wraps every response in. Responses from Barnacle are
 * required to match this shape exactly so clients can reuse their VPS
 * parsers without modification.
 */
export const vpsStatusSchema = z
  .object({
    httpStatus: vpsHttpStatusSchema,
    dateTime: z.string(),
    details: z.array(statusDetailSchema).default([]),
  })
  .passthrough();

export type VpsStatus = z.infer<typeof vpsStatusSchema>;
export type StatusDetail = z.infer<typeof statusDetailSchema>;

/**
 * Helper that wraps any domain schema in the standard VPS envelope (a top-
 * level `status` object merged with the domain payload).
 */
export function withVpsEnvelope<T extends z.ZodTypeAny>(payload: T) {
  return z.intersection(z.object({ status: vpsStatusSchema }), payload);
}

/**
 * Brand codes RC supports. `R` = Royal Caribbean International, `C` =
 * Celebrity Cruises. We parse any single-letter string to stay lenient if
 * RC adds a new brand.
 */
export const brandCodeSchema = z.union([z.literal("R"), z.literal("C"), z.string().length(1)]);
export type BrandCode = z.infer<typeof brandCodeSchema>;

/**
 * Sail-date string. RC uses `YYYY-MM-DD` in catalog responses and `YYYYMMDD`
 * (numeric) in delta responses, so we accept both.
 */
export const sailDateStringSchema = z.string().regex(/^(\d{4}-\d{2}-\d{2}|\d{8})$/);

/**
 * Timestamp as a numeric `YYYYMMDDHHMMSS`. RC uses this in promotion-details.
 * Max year is `9999` (sentinel value `99991231235959` indicates "open-ended").
 */
export const numericDateTimeSchema = z.number().int().min(10000101000000).max(99991231235959);

/**
 * ISO-8601 timestamp with optional nanoseconds, as produced by RC in the
 * status envelope. We don't try to parse to Date — string round-tripping is
 * sufficient for parity.
 */
export const isoDateTimeSchema = z.string().min(10);

/**
 * Inbound identifier for an agency (client-scoped queries).
 */
export const clientIdentifierSchema = z
  .object({
    agencyId: z.string(),
    currencyCodes: z.array(z.string()).nonempty(),
    clientId: z.string().optional(),
    companyShortName: z.string().optional(),
  })
  .passthrough();

/**
 * Inbound identifier for a market (market-scoped queries — used when an
 * agencyId is not available).
 */
export const marketIdentifierSchema = z
  .object({
    officeCode: z.string(),
    countryCode: z.string(),
    currencyCodes: z.array(z.string()).nonempty(),
  })
  .passthrough();

/**
 * Booking-type codes: I = individual, G = group.
 */
export const bookingTypeCodeSchema = z.union([
  z.literal("I"),
  z.literal("G"),
  z.string().length(1),
]);

/**
 * Occupancy integer — RC supports 1 through 4 guests per stateroom in VPS.
 */
export const occupancySchema = z.number().int().min(1).max(8);

/**
 * Pricing preference block shared by all three pricing endpoints.
 */
export const pricingPreferenceSchema = z
  .object({
    depositFareType: z
      .union([z.literal("BOTH"), z.literal("REF"), z.literal("NON_REF"), z.string()])
      .optional(),
    includeGuestLevelDetail: z.boolean().optional(),
    includeGratuity: z.boolean().optional(),
  })
  .passthrough();

/**
 * Flexible sail-date that accepts either `YYYY-MM-DD` (catalog responses)
 * or a `YYYYMMDD` integer (delta responses).
 */
export const flexibleSailDateSchema = z.union([sailDateStringSchema, z.number().int()]);

/**
 * A single sailing identity tuple (shipCode, sailDate, packageCode). Used
 * as keys in the delta endpoints. `sailDate` is numeric on the wire for
 * delta responses and string for catalog responses.
 */
export const sailingKeySchema = z
  .object({
    brandCode: brandCodeSchema.optional(),
    shipCode: z.string(),
    sailDate: flexibleSailDateSchema,
    packageCode: z.string(),
  })
  .passthrough();

/**
 * Date-time range RC echoes back in the delta responses to confirm which
 * window was actually processed (it may clip against server-side bounds).
 */
export const dateTimeRangeSchema = z
  .object({
    fromDateTime: z.string(),
    toDateTime: z.string(),
  })
  .passthrough();
