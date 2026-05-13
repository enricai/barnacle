import {
  priceChangeRequestSchema,
  priceChangeResponseSchema,
} from "@/api/schemas/price-changes-common";

/**
 * `POST /v1/pricing-snapshot/price-changes/super-category` — returns the
 * set of sailing keys whose super-category-level pricing has changed since
 * `fromDateTime`.
 */
export const priceChangesSuperCategoryRequestSchema = priceChangeRequestSchema;
export const priceChangesSuperCategoryResponseSchema = priceChangeResponseSchema;
