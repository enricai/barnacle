import { z } from "zod";

import { vpsStatusSchema } from "@/api/schemas/common";
import {
  categoryBestPriceSchema,
  pricingMetaInfoSchema,
  pricingRequestBaseSchema,
} from "@/api/schemas/pricing-common";

/**
 * Request body for `POST /v1/partner-pricing/group-pricing`. RC requires
 * `bookingTypeCode === "G"` here; we don't hard-enforce it in the Zod schema
 * because RC's server will return a domain error if the booking type and
 * endpoint don't match, which is the parity behavior.
 */
export const groupPricingRequestSchema = pricingRequestBaseSchema;

/**
 * Group-pricing response wraps category entries in a `groupId`-scoped
 * container. Each group shell may allocate several categories; the
 * `allocatedCategoryBasePrices` and `allocatedCategoryBestPrices` arrays
 * share the same per-category shape (stateroomCategoryCode + bestRate +
 * bestValue) — the fixture ships them identically.
 */
const groupBestPriceSchema = z
  .object({
    groupId: z.string(),
    allocatedCategoryBestPrices: z.array(categoryBestPriceSchema).optional(),
    allocatedCategoryBasePrices: z.array(categoryBestPriceSchema).optional(),
  })
  .passthrough();

export const groupPricingResponseSchema = z
  .object({
    status: vpsStatusSchema,
    metaInfo: pricingMetaInfoSchema.optional(),
    groupBestPrices: z.array(groupBestPriceSchema),
  })
  .passthrough();

export type GroupPricingResponse = z.infer<typeof groupPricingResponseSchema>;
