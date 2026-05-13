import { z } from "zod";

import { vpsStatusSchema } from "@/api/schemas/common";
import {
  leadPromotionSchema,
  pricingRequestBaseSchema,
  superCategoryBestPriceSchema,
} from "@/api/schemas/pricing-common";

/**
 * Request body for `POST /v1/partner-pricing/super-category-pricing`. The
 * super-category endpoint uses the canonical pricing request envelope as-is.
 */
export const superCategoryPricingRequestSchema = pricingRequestBaseSchema;
export type SuperCategoryPricingRequest = z.infer<typeof superCategoryPricingRequestSchema>;

/**
 * A single entry in the response's top-level `promotionBestPrices[]` array.
 * Each entry describes one promotion scenario plus the best prices per
 * super-category under that scenario.
 */
export const superCategoryPromotionBestPriceSchema = z
  .object({
    leadPromotion: leadPromotionSchema,
    eligible: z.boolean(),
    combinableWith: z.array(z.unknown()).default([]),
    superCategoryBestPrices: z.array(superCategoryBestPriceSchema),
  })
  .passthrough();

export const superCategoryPricingResponseSchema = z
  .object({
    status: vpsStatusSchema,
    promotionBestPrices: z.array(superCategoryPromotionBestPriceSchema),
  })
  .passthrough();

export type SuperCategoryPricingResponse = z.infer<typeof superCategoryPricingResponseSchema>;
