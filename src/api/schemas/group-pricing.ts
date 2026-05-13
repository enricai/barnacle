import { z } from "zod";

import { vpsStatusSchema } from "@/api/schemas/common";
import {
  bestRateSchema,
  categoryBestPriceSchema,
  pricingRequestBaseSchema,
} from "@/api/schemas/pricing-common";

/**
 * Request body for `POST /v1/partner-pricing/group-pricing`. RC requires
 * `bookingTypeCode === "G"` here; we don't hard-enforce it in the Zod schema
 * because RC's server will return a domain error if the booking type and
 * endpoint don't match, which is the parity behavior.
 */
export const groupPricingRequestSchema = pricingRequestBaseSchema;
export type GroupPricingRequest = z.infer<typeof groupPricingRequestSchema>;

/**
 * Group-pricing response wraps category entries in a `groupId`-scoped
 * container. Each group shell may allocate several categories; base-only
 * rates are returned alongside promotion-applied rates.
 */
export const allocatedCategoryBasePriceSchema = z
  .object({
    stateroomCategoryCode: z.string(),
    baseRate: bestRateSchema.optional(),
  })
  .passthrough();

export const groupBestPriceSchema = z
  .object({
    groupId: z.string(),
    allocatedCategoryBestPrices: z.array(categoryBestPriceSchema).optional(),
    allocatedCategoryBasePrices: z.array(allocatedCategoryBasePriceSchema).optional(),
  })
  .passthrough();

export const groupPricingResponseSchema = z
  .object({
    status: vpsStatusSchema,
    groupBestPrices: z.array(groupBestPriceSchema),
  })
  .passthrough();

export type GroupPricingResponse = z.infer<typeof groupPricingResponseSchema>;
