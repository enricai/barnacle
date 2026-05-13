"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.categoryPricingResponseSchema = exports.categoryBasePriceRateSchema = exports.categoryPromotionBestPriceSchema = exports.categoryPricingRequestSchema = void 0;
const zod_1 = require("zod");
const common_1 = require("@/api/schemas/common");
const pricing_common_1 = require("@/api/schemas/pricing-common");
/**
 * Request body for `POST /v1/partner-pricing/category-pricing`. Identical
 * shape to super-category pricing, with an optional `categoryCode` filter
 * RC accepts to narrow the response.
 */
exports.categoryPricingRequestSchema = pricing_common_1.pricingRequestBaseSchema.and(zod_1.z.object({
    categoryCode: zod_1.z.string().optional(),
}));
exports.categoryPromotionBestPriceSchema = zod_1.z
    .object({
    leadPromotion: pricing_common_1.leadPromotionSchema,
    eligible: zod_1.z.boolean(),
    combinableWith: zod_1.z.array(zod_1.z.unknown()).default([]),
    categoryBestPrices: zod_1.z.array(pricing_common_1.categoryBestPriceSchema),
})
    .passthrough();
/**
 * Base-price-only entry (no promotion applied). RC returns these alongside
 * the promotion-applied variants so clients can display a "before promo"
 * comparison.
 */
exports.categoryBasePriceRateSchema = zod_1.z
    .object({
    stateroomCategoryCode: zod_1.z.string(),
    baseRate: pricing_common_1.bestRateSchema.optional(),
})
    .passthrough();
exports.categoryPricingResponseSchema = zod_1.z
    .object({
    status: common_1.vpsStatusSchema,
    promotionBestPrices: zod_1.z.array(exports.categoryPromotionBestPriceSchema).optional(),
    categoryBestPrices: zod_1.z.array(pricing_common_1.categoryBestPriceSchema).optional(),
    categoryBasePriceRates: zod_1.z.array(exports.categoryBasePriceRateSchema).optional(),
})
    .passthrough();
//# sourceMappingURL=category-pricing.js.map