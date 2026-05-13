import { z } from "zod";

import { brandCodeSchema, numericDateTimeSchema, vpsStatusSchema } from "@/api/schemas/common";

/**
 * Promotion-details is a client-scoped OR market-scoped request — same
 * either/or split used by price-changes. One of `client` or `market` must
 * be provided.
 */
export const promotionClientSchema = z
  .object({
    agencyId: z.string(),
    currencyCodes: z.array(z.string()).nonempty(),
  })
  .passthrough();

export const promotionMarketSchema = z
  .object({
    officeCode: z.string(),
    countryCode: z.string(),
    currencyCodes: z.array(z.string()).nonempty(),
  })
  .passthrough();

export const promotionDetailsRequestSchema = z
  .object({
    brand: brandCodeSchema,
    client: promotionClientSchema.optional(),
    market: promotionMarketSchema.optional(),
  })
  .passthrough()
  .refine((value) => value.client !== undefined || value.market !== undefined, {
    message: "one of `client` or `market` is required",
  });

export type PromotionDetailsRequest = z.infer<typeof promotionDetailsRequestSchema>;

const ageRestrictionSchema = z
  .object({
    min: z.number().int().nullable().optional(),
    max: z.number().int().nullable().optional(),
  })
  .passthrough();

export const promotionGuestRestrictionsSchema = z
  .object({
    loyaltyRestriction: z.boolean().optional(),
    ageRestriction: ageRestrictionSchema.optional(),
    residencyCodes: z.array(z.string()).optional(),
    publicServices: z.array(z.unknown()).optional(),
    lifeStages: z.array(z.string()).optional(),
  })
  .passthrough();

/**
 * One entry in the `promotions[]` array. RC mixes a lot of optional
 * metadata (agency types, eligibility, combinability) into this record,
 * all of which we pass through unchanged so the schema stays stable as
 * new fields appear.
 */
export const promotionSchema = z
  .object({
    id: z.string(),
    shortDescription: z.string().optional(),
    brand: brandCodeSchema,
    startDateTime: numericDateTimeSchema,
    endDateTime: numericDateTimeSchema,
    typeCode: z.string().optional(),
    subTypeCode: z.string().optional(),
    promotionClassType: z.string().optional(),
    refundableType: z.string().optional(),
    sailingRestricted: z.boolean().optional(),
    categoryRestricted: z.boolean().optional(),
    occupancyRestricted: z.boolean().optional(),
    gatewayRestricted: z.boolean().optional(),
    guestRestricted: z.boolean().optional(),
    promoCodeRestricted: z.boolean().optional(),
    promotionGuestRestrictions: promotionGuestRestrictionsSchema.optional(),
  })
  .passthrough();

export const promotionDetailsResponseSchema = z
  .object({
    status: vpsStatusSchema,
    promotions: z.array(promotionSchema),
  })
  .passthrough();

export type Promotion = z.infer<typeof promotionSchema>;
export type PromotionDetailsResponse = z.infer<typeof promotionDetailsResponseSchema>;
