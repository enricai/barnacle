"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.priceChangeResponseSchema = exports.priceChangeKeySchema = exports.priceChangeRequestSchema = exports.priceChangeRequestMarketSchema = exports.priceChangeRequestClientSchema = void 0;
const zod_1 = require("zod");
const common_1 = require("@/api/schemas/common");
/**
 * RC's price-change identification requests accept EITHER a client block
 * (by agencyId + currencies) OR a market block (office/country/currencies).
 * We model the two as a discriminated-union-ish shape: both optional, at
 * least one required. Clients pick whichever fits their onboarding.
 */
exports.priceChangeRequestClientSchema = zod_1.z
    .object({
    agencyId: zod_1.z.string(),
    currencyCodes: zod_1.z.array(zod_1.z.string()).nonempty().optional(),
})
    .passthrough();
exports.priceChangeRequestMarketSchema = zod_1.z
    .object({
    officeCode: zod_1.z.string(),
    countryCode: zod_1.z.string(),
    currencyCodes: zod_1.z.array(zod_1.z.string()).nonempty(),
})
    .passthrough();
exports.priceChangeRequestSchema = zod_1.z
    .object({
    fromDateTime: common_1.isoDateTimeSchema,
    client: exports.priceChangeRequestClientSchema.optional(),
    market: exports.priceChangeRequestMarketSchema.optional(),
})
    .passthrough()
    .refine((value) => value.client !== undefined || value.market !== undefined, {
    message: "one of `client` or `market` is required",
});
/**
 * One entry in the `keys[]` array of a price-change response. Embellished
 * with the market coordinates that produced the change (currency, office,
 * etc.) so clients can scope the subsequent pricing re-fetch correctly.
 */
exports.priceChangeKeySchema = zod_1.z
    .object({
    shipCode: zod_1.z.string(),
    sailDate: common_1.flexibleSailDateSchema,
    packageCode: zod_1.z.string(),
    officeCode: zod_1.z.string().optional(),
    countryCode: zod_1.z.string().optional(),
    currencyCode: zod_1.z.string().optional(),
    bookingChannel: zod_1.z.string().optional(),
    bookingType: common_1.bookingTypeCodeSchema.optional(),
    occupancy: common_1.occupancySchema.optional(),
})
    .passthrough();
exports.priceChangeResponseSchema = zod_1.z
    .object({
    status: common_1.vpsStatusSchema,
    keys: zod_1.z.array(exports.priceChangeKeySchema),
    dateTimeRange: common_1.dateTimeRangeSchema.optional(),
})
    .passthrough();
//# sourceMappingURL=price-changes-common.js.map