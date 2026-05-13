import {
  type PriceChangeRequest,
  type PriceChangeResponse,
  priceChangeRequestSchema,
  priceChangeResponseSchema,
} from "@/api/schemas/price-changes-common";

/**
 * `POST /v1/pricing-snapshot/price-changes/category` — returns the set of
 * sailing keys whose category-level pricing has changed since `fromDateTime`.
 */
export const priceChangesCategoryRequestSchema = priceChangeRequestSchema;
export const priceChangesCategoryResponseSchema = priceChangeResponseSchema;

export type PriceChangesCategoryRequest = PriceChangeRequest;
export type PriceChangesCategoryResponse = PriceChangeResponse;
