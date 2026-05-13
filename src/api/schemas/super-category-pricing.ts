import { z } from "zod";

import { vpsStatusSchema } from "@/api/schemas/common";
import {
  brochureStandardRatePairSchema,
  leadPromotionSchema,
  pricingMetaInfoSchema,
  pricingRequestBaseSchema,
  superCategoryBestPriceSchema,
} from "@/api/schemas/pricing-common";

/**
 * Request body for `POST /v1/partner-pricing/super-category-pricing`. The
 * super-category endpoint uses the canonical pricing request envelope as-is.
 */
export const superCategoryPricingRequestSchema = pricingRequestBaseSchema;

/**
 * A single entry in the response's top-level `promotionBestPrices[]` array.
 * Each entry describes one promotion scenario plus the best prices per
 * super-category under that scenario.
 */
const superCategoryPromotionBestPriceSchema = z
  .object({
    leadPromotion: leadPromotionSchema,
    eligible: z.boolean(),
    combinableWith: z.array(z.unknown()).default([]),
    superCategoryBestPrices: z.array(superCategoryBestPriceSchema),
  })
  .passthrough();

/**
 * `superCategoryBasePriceRates[i]` — brochure-vs-standard base rates per
 * super-category, without a promotion scenario wrapper. Separate from
 * `superCategoryBestPrices[]` which carries the promotion-scenario winning
 * rate.
 */
const superCategoryBasePriceRateSchema = z
  .object({
    stateroomSuperCategory: z.string(),
  })
  .merge(brochureStandardRatePairSchema);

export const superCategoryPricingResponseSchema = z
  .object({
    status: vpsStatusSchema,
    metaInfo: pricingMetaInfoSchema.optional(),
    promotionBestPrices: z.array(superCategoryPromotionBestPriceSchema),
    superCategoryBestPrices: z.array(superCategoryBestPriceSchema).optional(),
    superCategoryBasePriceRates: z.array(superCategoryBasePriceRateSchema).optional(),
  })
  .passthrough();

export type SuperCategoryPricingResponse = z.infer<typeof superCategoryPricingResponseSchema>;
