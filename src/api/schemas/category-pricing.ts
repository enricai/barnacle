import { z } from "zod";

import { vpsStatusSchema } from "@/api/schemas/common";
import {
  bestRateSchema,
  categoryBestPriceSchema,
  leadPromotionSchema,
  pricingRequestBaseSchema,
} from "@/api/schemas/pricing-common";

/**
 * Request body for `POST /v1/partner-pricing/category-pricing`. Identical
 * shape to super-category pricing, with an optional `categoryCode` filter
 * RC accepts to narrow the response.
 */
export const categoryPricingRequestSchema = pricingRequestBaseSchema.and(
  z.object({
    categoryCode: z.string().optional(),
  })
);
export type CategoryPricingRequest = z.infer<typeof categoryPricingRequestSchema>;

export const categoryPromotionBestPriceSchema = z
  .object({
    leadPromotion: leadPromotionSchema,
    eligible: z.boolean(),
    combinableWith: z.array(z.unknown()).default([]),
    categoryBestPrices: z.array(categoryBestPriceSchema),
  })
  .passthrough();

/**
 * Base-price-only entry (no promotion applied). RC returns these alongside
 * the promotion-applied variants so clients can display a "before promo"
 * comparison.
 */
export const categoryBasePriceRateSchema = z
  .object({
    stateroomCategoryCode: z.string(),
    baseRate: bestRateSchema.optional(),
  })
  .passthrough();

export const categoryPricingResponseSchema = z
  .object({
    status: vpsStatusSchema,
    promotionBestPrices: z.array(categoryPromotionBestPriceSchema).optional(),
    categoryBestPrices: z.array(categoryBestPriceSchema).optional(),
    categoryBasePriceRates: z.array(categoryBasePriceRateSchema).optional(),
  })
  .passthrough();

export type CategoryPricingResponse = z.infer<typeof categoryPricingResponseSchema>;
