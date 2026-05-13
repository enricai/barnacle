"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.promotionDetailsResponseSchema = exports.promotionSchema = exports.promotionGuestRestrictionsSchema = exports.promotionDetailsRequestSchema = exports.promotionMarketSchema = exports.promotionClientSchema = void 0;
const zod_1 = require("zod");
const common_1 = require("@/api/schemas/common");
/**
 * Promotion-details is a client-scoped OR market-scoped request — same
 * either/or split used by price-changes. One of `client` or `market` must
 * be provided.
 */
exports.promotionClientSchema = zod_1.z
    .object({
    agencyId: zod_1.z.string(),
    currencyCodes: zod_1.z.array(zod_1.z.string()).nonempty(),
})
    .passthrough();
exports.promotionMarketSchema = zod_1.z
    .object({
    officeCode: zod_1.z.string(),
    countryCode: zod_1.z.string(),
    currencyCodes: zod_1.z.array(zod_1.z.string()).nonempty(),
})
    .passthrough();
exports.promotionDetailsRequestSchema = zod_1.z
    .object({
    brand: common_1.brandCodeSchema,
    client: exports.promotionClientSchema.optional(),
    market: exports.promotionMarketSchema.optional(),
})
    .passthrough()
    .refine((value) => value.client !== undefined || value.market !== undefined, {
    message: "one of `client` or `market` is required",
});
const ageRestrictionSchema = zod_1.z
    .object({
    min: zod_1.z.number().int().nullable().optional(),
    max: zod_1.z.number().int().nullable().optional(),
})
    .passthrough();
exports.promotionGuestRestrictionsSchema = zod_1.z
    .object({
    loyaltyRestriction: zod_1.z.boolean().optional(),
    ageRestriction: ageRestrictionSchema.optional(),
    residencyCodes: zod_1.z.array(zod_1.z.string()).optional(),
    publicServices: zod_1.z.array(zod_1.z.unknown()).optional(),
    lifeStages: zod_1.z.array(zod_1.z.string()).optional(),
})
    .passthrough();
/**
 * One entry in the `promotions[]` array. RC mixes a lot of optional
 * metadata (agency types, eligibility, combinability) into this record,
 * all of which we pass through unchanged so the schema stays stable as
 * new fields appear.
 */
exports.promotionSchema = zod_1.z
    .object({
    id: zod_1.z.string(),
    shortDescription: zod_1.z.string().optional(),
    brand: common_1.brandCodeSchema,
    startDateTime: common_1.numericDateTimeSchema,
    endDateTime: common_1.numericDateTimeSchema,
    typeCode: zod_1.z.string().optional(),
    subTypeCode: zod_1.z.string().optional(),
    promotionClassType: zod_1.z.string().optional(),
    refundableType: zod_1.z.string().optional(),
    sailingRestricted: zod_1.z.boolean().optional(),
    categoryRestricted: zod_1.z.boolean().optional(),
    occupancyRestricted: zod_1.z.boolean().optional(),
    gatewayRestricted: zod_1.z.boolean().optional(),
    guestRestricted: zod_1.z.boolean().optional(),
    promoCodeRestricted: zod_1.z.boolean().optional(),
    promotionGuestRestrictions: exports.promotionGuestRestrictionsSchema.optional(),
})
    .passthrough();
exports.promotionDetailsResponseSchema = zod_1.z
    .object({
    status: common_1.vpsStatusSchema,
    promotions: zod_1.z.array(exports.promotionSchema),
})
    .passthrough();
//# sourceMappingURL=promotion-details.js.map