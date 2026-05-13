import { z } from "zod";

import {
  bookingTypeCodeSchema,
  brandCodeSchema,
  occupancySchema,
  pricingPreferenceSchema,
  sailDateStringSchema,
} from "@/api/schemas/common";

/**
 * Fields shared across the three pricing endpoints (super-category, category,
 * group). Each endpoint's request schema extends this base with its own
 * defaults for `bookingTypeCode` and any endpoint-specific filters.
 *
 * @see `RC_API_Docs/Sample Super Category Pricing Request and Response.json`
 * @see `RC_API_Docs/Sample Category Pricing Request and Response.json`
 * @see `RC_API_Docs/Sample Group Pricing Request and Response.json`
 */
export const clientContextSchema = z
  .object({
    clientContext: z.string().optional(),
    clientId: z.string(),
  })
  .passthrough();

export const guestPreferenceSchema = z
  .object({
    age: z.number().int().optional(),
    lifeStageCode: z.string().optional(),
  })
  .passthrough();

/**
 * Canonical request envelope for the three pricing endpoints. RC accepts the
 * same body shape for super-category, category, and group pricing — only
 * `bookingTypeCode` differs in practice (group pricing requires `"G"`).
 */
export const pricingRequestBaseSchema = z
  .object({
    clients: z.array(clientContextSchema).min(1),
    companyShortName: z.string(),
    brandCode: brandCodeSchema,
    shipCode: z.string(),
    sailDate: sailDateStringSchema,
    packageCode: z.string(),
    bookingChannel: z.string().optional(),
    officeCode: z.string(),
    countryCode: z.string(),
    currencyCode: z.string(),
    occupancy: occupancySchema,
    bookingTypeCode: bookingTypeCodeSchema,
    pricingPreference: pricingPreferenceSchema.optional(),
    guestPreferences: z.array(guestPreferenceSchema).optional(),
  })
  .passthrough();

export type PricingRequestBase = z.infer<typeof pricingRequestBaseSchema>;

/**
 * Per-guest price point. `guestSequenceId` is null on the averaged rollup,
 * and 1-indexed on individual guest rows. All amounts are in the request's
 * `currencyCode`.
 */
export const guestPricePointSchema = z
  .object({
    guestSequenceId: z.number().int().nullable().optional(),
    appliedLifeStage: z.string().nullable().optional(),
    netTotal: z.number(),
    includedInNetTotal: z.array(z.string()).optional(),
    netCruiseFareAmount: z.number().optional(),
    nonComissionalCruiseFareAmount: z.number().optional(),
    taxesAndFeesAmount: z.number().optional(),
    gratuityAmount: z.number().optional(),
    netDiscountAmount: z.number().optional(),
    valueAdds: z.array(z.unknown()).optional(),
    originalAmount: z.number().optional(),
  })
  .passthrough();

export const leadPromotionSchema = z
  .object({
    promotionId: z.string(),
    shortDescription: z.string().optional(),
  })
  .passthrough();

/**
 * A `bestRate` / `bestValue` entry — the actual price lock-in for a
 * (category, promotion) pair. Shared by every pricing response shape.
 */
export const bestRateSchema = z
  .object({
    stateroomCategoryCode: z.string(),
    guaranteeCategoryFlag: z.boolean().optional(),
    stateroomSuperCategory: z.string().optional(),
    stateroomTypeCode: z.string().optional(),
    restrictedPromotionApplied: z.boolean().optional(),
    accessibleStateroomExistFlag: z.boolean().optional(),
    refundableFareFlag: z.boolean().optional(),
    appliedBasePriceId: z.string().optional(),
    basePriceShortDescription: z.string().optional(),
    basePriceType: z.string().optional(),
    appliedPromotionIds: z.array(z.string()).optional(),
    promoCodeApplied: z.boolean().optional(),
    leadPromotion: leadPromotionSchema.optional(),
    averagePerGuestPricePoint: guestPricePointSchema.optional(),
    guestPricePoints: z.array(guestPricePointSchema).optional(),
  })
  .passthrough();

/**
 * Wraps a `bestRate` with an optional `bestValue` alternative — RC returns
 * `null` for bestValue when only a best-rate quote is available.
 */
export const bestPriceEnvelopeSchema = z
  .object({
    bestRate: bestRateSchema.optional(),
    bestValue: bestRateSchema.nullable().optional(),
  })
  .passthrough();

/**
 * `superCategoryBestPrices[i]` entry in the super-category response.
 */
export const superCategoryBestPriceSchema = z
  .object({
    superCategoryCode: z.string(),
    superCategoryName: z.string().optional(),
  })
  .merge(bestPriceEnvelopeSchema)
  .passthrough();

/**
 * `categoryBestPrices[i]` entry in the category and group responses.
 */
export const categoryBestPriceSchema = z
  .object({
    stateroomCategoryCode: z.string(),
  })
  .merge(bestPriceEnvelopeSchema)
  .passthrough();
