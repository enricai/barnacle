"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.categoryBestPriceSchema = exports.superCategoryBestPriceSchema = exports.bestPriceEnvelopeSchema = exports.bestRateSchema = exports.leadPromotionSchema = exports.guestPricePointSchema = exports.pricingRequestBaseSchema = exports.guestPreferenceSchema = exports.clientContextSchema = void 0;
const zod_1 = require("zod");
const common_1 = require("@/api/schemas/common");
/**
 * Fields shared across the three pricing endpoints (super-category, category,
 * group). Each endpoint's request schema extends this base with its own
 * defaults for `bookingTypeCode` and any endpoint-specific filters.
 *
 * @see `RC_API_Docs/Sample Super Category Pricing Request and Response.json`
 * @see `RC_API_Docs/Sample Category Pricing Request and Response.json`
 * @see `RC_API_Docs/Sample Group Pricing Request and Response.json`
 */
exports.clientContextSchema = zod_1.z
    .object({
    clientContext: zod_1.z.string().optional(),
    clientId: zod_1.z.string(),
})
    .passthrough();
exports.guestPreferenceSchema = zod_1.z
    .object({
    age: zod_1.z.number().int().optional(),
    lifeStageCode: zod_1.z.string().optional(),
})
    .passthrough();
/**
 * Canonical request envelope for the three pricing endpoints. RC accepts the
 * same body shape for super-category, category, and group pricing — only
 * `bookingTypeCode` differs in practice (group pricing requires `"G"`).
 */
exports.pricingRequestBaseSchema = zod_1.z
    .object({
    clients: zod_1.z.array(exports.clientContextSchema).min(1),
    companyShortName: zod_1.z.string(),
    brandCode: common_1.brandCodeSchema,
    shipCode: zod_1.z.string(),
    sailDate: common_1.sailDateStringSchema,
    packageCode: zod_1.z.string(),
    bookingChannel: zod_1.z.string().optional(),
    officeCode: zod_1.z.string(),
    countryCode: zod_1.z.string(),
    currencyCode: zod_1.z.string(),
    occupancy: common_1.occupancySchema,
    bookingTypeCode: common_1.bookingTypeCodeSchema,
    pricingPreference: common_1.pricingPreferenceSchema.optional(),
    guestPreferences: zod_1.z.array(exports.guestPreferenceSchema).optional(),
})
    .passthrough();
/**
 * Per-guest price point. `guestSequenceId` is null on the averaged rollup,
 * and 1-indexed on individual guest rows. All amounts are in the request's
 * `currencyCode`.
 */
exports.guestPricePointSchema = zod_1.z
    .object({
    guestSequenceId: zod_1.z.number().int().nullable().optional(),
    appliedLifeStage: zod_1.z.string().nullable().optional(),
    netTotal: zod_1.z.number(),
    includedInNetTotal: zod_1.z.array(zod_1.z.string()).optional(),
    netCruiseFareAmount: zod_1.z.number().optional(),
    nonComissionalCruiseFareAmount: zod_1.z.number().optional(),
    taxesAndFeesAmount: zod_1.z.number().optional(),
    gratuityAmount: zod_1.z.number().optional(),
    netDiscountAmount: zod_1.z.number().optional(),
    valueAdds: zod_1.z.array(zod_1.z.unknown()).optional(),
    originalAmount: zod_1.z.number().optional(),
})
    .passthrough();
exports.leadPromotionSchema = zod_1.z
    .object({
    promotionId: zod_1.z.string(),
    shortDescription: zod_1.z.string().optional(),
})
    .passthrough();
/**
 * A `bestRate` / `bestValue` entry — the actual price lock-in for a
 * (category, promotion) pair. Shared by every pricing response shape.
 */
exports.bestRateSchema = zod_1.z
    .object({
    stateroomCategoryCode: zod_1.z.string(),
    guaranteeCategoryFlag: zod_1.z.boolean().optional(),
    stateroomSuperCategory: zod_1.z.string().optional(),
    stateroomTypeCode: zod_1.z.string().optional(),
    restrictedPromotionApplied: zod_1.z.boolean().optional(),
    accessibleStateroomExistFlag: zod_1.z.boolean().optional(),
    refundableFareFlag: zod_1.z.boolean().optional(),
    appliedBasePriceId: zod_1.z.string().optional(),
    basePriceShortDescription: zod_1.z.string().optional(),
    basePriceType: zod_1.z.string().optional(),
    appliedPromotionIds: zod_1.z.array(zod_1.z.string()).optional(),
    promoCodeApplied: zod_1.z.boolean().optional(),
    leadPromotion: exports.leadPromotionSchema.optional(),
    averagePerGuestPricePoint: exports.guestPricePointSchema.optional(),
    guestPricePoints: zod_1.z.array(exports.guestPricePointSchema).optional(),
})
    .passthrough();
/**
 * Wraps a `bestRate` with an optional `bestValue` alternative — RC returns
 * `null` for bestValue when only a best-rate quote is available.
 */
exports.bestPriceEnvelopeSchema = zod_1.z
    .object({
    bestRate: exports.bestRateSchema.optional(),
    bestValue: exports.bestRateSchema.nullable().optional(),
})
    .passthrough();
/**
 * `superCategoryBestPrices[i]` entry in the super-category response.
 */
exports.superCategoryBestPriceSchema = zod_1.z
    .object({
    superCategoryCode: zod_1.z.string(),
    superCategoryName: zod_1.z.string().optional(),
})
    .merge(exports.bestPriceEnvelopeSchema)
    .passthrough();
/**
 * `categoryBestPrices[i]` entry in the category and group responses.
 */
exports.categoryBestPriceSchema = zod_1.z
    .object({
    stateroomCategoryCode: zod_1.z.string(),
})
    .merge(exports.bestPriceEnvelopeSchema)
    .passthrough();
//# sourceMappingURL=pricing-common.js.map