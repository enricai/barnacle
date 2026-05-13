"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.superCategoryPricingResponseSchema = exports.superCategoryPromotionBestPriceSchema = exports.superCategoryPricingRequestSchema = void 0;
const zod_1 = require("zod");
const common_1 = require("@/api/schemas/common");
const pricing_common_1 = require("@/api/schemas/pricing-common");
/**
 * Request body for `POST /v1/partner-pricing/super-category-pricing`. The
 * super-category endpoint uses the canonical pricing request envelope as-is.
 */
exports.superCategoryPricingRequestSchema = pricing_common_1.pricingRequestBaseSchema;
/**
 * A single entry in the response's top-level `promotionBestPrices[]` array.
 * Each entry describes one promotion scenario plus the best prices per
 * super-category under that scenario.
 */
exports.superCategoryPromotionBestPriceSchema = zod_1.z
    .object({
    leadPromotion: pricing_common_1.leadPromotionSchema,
    eligible: zod_1.z.boolean(),
    combinableWith: zod_1.z.array(zod_1.z.unknown()).default([]),
    superCategoryBestPrices: zod_1.z.array(pricing_common_1.superCategoryBestPriceSchema),
})
    .passthrough();
exports.superCategoryPricingResponseSchema = zod_1.z
    .object({
    status: common_1.vpsStatusSchema,
    promotionBestPrices: zod_1.z.array(exports.superCategoryPromotionBestPriceSchema),
})
    .passthrough();
//# sourceMappingURL=super-category-pricing.js.map