"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.groupPricingResponseSchema = exports.groupBestPriceSchema = exports.allocatedCategoryBasePriceSchema = exports.groupPricingRequestSchema = void 0;
const zod_1 = require("zod");
const common_1 = require("@/api/schemas/common");
const pricing_common_1 = require("@/api/schemas/pricing-common");
/**
 * Request body for `POST /v1/partner-pricing/group-pricing`. RC requires
 * `bookingTypeCode === "G"` here; we don't hard-enforce it in the Zod schema
 * because RC's server will return a domain error if the booking type and
 * endpoint don't match, which is the parity behavior.
 */
exports.groupPricingRequestSchema = pricing_common_1.pricingRequestBaseSchema;
/**
 * Group-pricing response wraps category entries in a `groupId`-scoped
 * container. Each group shell may allocate several categories; base-only
 * rates are returned alongside promotion-applied rates.
 */
exports.allocatedCategoryBasePriceSchema = zod_1.z
    .object({
    stateroomCategoryCode: zod_1.z.string(),
    baseRate: pricing_common_1.bestRateSchema.optional(),
})
    .passthrough();
exports.groupBestPriceSchema = zod_1.z
    .object({
    groupId: zod_1.z.string(),
    allocatedCategoryBestPrices: zod_1.z.array(pricing_common_1.categoryBestPriceSchema).optional(),
    allocatedCategoryBasePrices: zod_1.z.array(exports.allocatedCategoryBasePriceSchema).optional(),
})
    .passthrough();
exports.groupPricingResponseSchema = zod_1.z
    .object({
    status: common_1.vpsStatusSchema,
    groupBestPrices: zod_1.z.array(exports.groupBestPriceSchema),
})
    .passthrough();
//# sourceMappingURL=group-pricing.js.map