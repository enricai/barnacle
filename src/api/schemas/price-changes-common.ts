import { z } from "zod";

import {
  bookingTypeCodeSchema,
  dateTimeRangeSchema,
  flexibleSailDateSchema,
  isoDateTimeSchema,
  occupancySchema,
  vpsStatusSchema,
} from "@/api/schemas/common";

/**
 * RC's price-change identification requests accept EITHER a client block
 * (by agencyId + currencies) OR a market block (office/country/currencies).
 * We model the two as a discriminated-union-ish shape: both optional, at
 * least one required. Clients pick whichever fits their onboarding.
 */
export const priceChangeRequestClientSchema = z
  .object({
    agencyId: z.string(),
    currencyCodes: z.array(z.string()).nonempty().optional(),
  })
  .passthrough();

export const priceChangeRequestMarketSchema = z
  .object({
    officeCode: z.string(),
    countryCode: z.string(),
    currencyCodes: z.array(z.string()).nonempty(),
  })
  .passthrough();

export const priceChangeRequestSchema = z
  .object({
    fromDateTime: isoDateTimeSchema,
    client: priceChangeRequestClientSchema.optional(),
    market: priceChangeRequestMarketSchema.optional(),
  })
  .passthrough()
  .refine((value) => value.client !== undefined || value.market !== undefined, {
    message: "one of `client` or `market` is required",
  });

export type PriceChangeRequest = z.infer<typeof priceChangeRequestSchema>;

/**
 * One entry in the `keys[]` array of a price-change response. Embellished
 * with the market coordinates that produced the change (currency, office,
 * etc.) so clients can scope the subsequent pricing re-fetch correctly.
 */
export const priceChangeKeySchema = z
  .object({
    shipCode: z.string(),
    sailDate: flexibleSailDateSchema,
    packageCode: z.string(),
    officeCode: z.string().optional(),
    countryCode: z.string().optional(),
    currencyCode: z.string().optional(),
    bookingChannel: z.string().optional(),
    bookingType: bookingTypeCodeSchema.optional(),
    occupancy: occupancySchema.optional(),
  })
  .passthrough();

export const priceChangeResponseSchema = z
  .object({
    status: vpsStatusSchema,
    keys: z.array(priceChangeKeySchema),
    dateTimeRange: dateTimeRangeSchema.optional(),
  })
  .passthrough();

export type PriceChangeResponse = z.infer<typeof priceChangeResponseSchema>;
