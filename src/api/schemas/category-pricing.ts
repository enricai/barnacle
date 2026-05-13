import { z } from "zod";

import { vpsStatusSchema } from "@/api/schemas/common";
import {
  brochureStandardRatePairSchema,
  categoryBestPriceSchema,
  leadPromotionSchema,
  pricingMetaInfoSchema,
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

const categoryPromotionBestPriceSchema = z
  .object({
    leadPromotion: leadPromotionSchema,
    eligible: z.boolean(),
    combinableWith: z.array(z.unknown()).default([]),
    categoryBestPrices: z.array(categoryBestPriceSchema),
  })
  .passthrough();

/**
 * `categoryBasePriceRates[i]` — brochure-vs-standard base rates per stateroom
 * category, no promotion applied. Clients display these alongside the
 * promotion-applied variants so users can see a "before promo" comparison.
 */
const categoryBasePriceRateSchema = z
  .object({
    stateroomCategoryCode: z.string(),
  })
  .merge(brochureStandardRatePairSchema);

export const categoryPricingResponseSchema = z
  .object({
    status: vpsStatusSchema,
    metaInfo: pricingMetaInfoSchema.optional(),
    promotionBestPrices: z.array(categoryPromotionBestPriceSchema).optional(),
    categoryBestPrices: z.array(categoryBestPriceSchema).optional(),
    categoryBasePriceRates: z.array(categoryBasePriceRateSchema).optional(),
  })
  .passthrough();

export type CategoryPricingResponse = z.infer<typeof categoryPricingResponseSchema>;
