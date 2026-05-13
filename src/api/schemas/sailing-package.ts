import { z } from "zod";

import { brandCodeSchema, sailDateStringSchema, vpsStatusSchema } from "@/api/schemas/common";

/**
 * Request parameters accepted by `GET /v1/catalog/sailing-package`. RC uses
 * query strings; we normalize to Zod-parsed, camelCase fields before passing
 * them into the service layer. `shipCodes` is a comma-separated list on the
 * wire but exposed as a proper array.
 */
const cabinTypeEnum = z.enum(["INTERIOR", "OUTSIDE", "BALCONY", "SUITE"]);

const cruiseLengthRangeSchema = z.object({
  min: z.number().int().min(1),
  max: z.number().int().min(1),
});

const sailingPackageRequestSchema = z
  .object({
    brandCode: brandCodeSchema,
    fromSailDate: sailDateStringSchema,
    toSailDate: sailDateStringSchema,
    shipCodes: z.array(z.string()).optional(),
    // TASKS.md Task 8 extended filter set — only exposed via POST /v1/search
    // today; the GET query-string route keeps the legacy minimal body.
    destinations: z.array(z.string()).optional(),
    departurePorts: z.array(z.string()).optional(),
    cruiseLengthRange: cruiseLengthRangeSchema.optional(),
    guestCount: z.number().int().min(1).optional(),
    cabinType: cabinTypeEnum.optional(),
    includeTourPackages: z.boolean().optional().default(false),
  })
  .strict();

export type SailingPackageRequest = z.infer<typeof sailingPackageRequestSchema>;

/**
 * Inbound query-string variant — same fields but `shipCodes` is a string and
 * `includeTourPackages` may be a string like `"true"`. Routes apply this
 * before handing to services.
 */
export const sailingPackageQueryStringSchema = z
  .object({
    brandCode: brandCodeSchema,
    fromSailDate: sailDateStringSchema,
    toSailDate: sailDateStringSchema,
    shipCodes: z.string().optional(),
    includeTourPackages: z.union([z.boolean(), z.string()]).optional(),
  })
  .transform(
    (input): SailingPackageRequest => ({
      brandCode: input.brandCode,
      fromSailDate: input.fromSailDate,
      toSailDate: input.toSailDate,
      shipCodes: input.shipCodes
        ? input.shipCodes
            .split(",")
            .map((code) => code.trim())
            .filter(Boolean)
        : undefined,
      includeTourPackages:
        typeof input.includeTourPackages === "boolean"
          ? input.includeTourPackages
          : input.includeTourPackages === "true",
    })
  );

/**
 * One entry in a sailing's itinerary schedule. RC exposes a deep itinerary
 * tree; we stay lenient (passthrough) because the doc explicitly allows
 * new enum values and fields.
 */
const itineraryStopSchema = z
  .object({
    dayNumber: z.number().int(),
    date: sailDateStringSchema.optional(),
    portCode: z.string().optional(),
    portName: z.string().optional(),
    // VPS's canonical field is `countryName` (full name like "UNITED
    // STATES"). Our GraphQL source only exposes a 3-letter countryCode
    // and a region label, so we surface both alongside — clients that
    // receive VPS fixtures see countryName; clients that receive
    // GraphQL-sourced responses see countryCode+region.
    countryName: z.string().optional().nullable(),
    countryCode: z.string().optional().nullable(),
    region: z.string().optional().nullable(),
    activity: z.string().optional(),
    arrivalTime: z.string().optional().nullable(),
    departureTime: z.string().optional().nullable(),
  })
  .passthrough();

const sailingItinerarySchema = z
  .object({
    itineraryCode: z.string().optional(),
    duration: z.number().int().optional(),
    schedule: z.array(itineraryStopSchema),
    itineraryType: z.string().nullable().optional(),
    voyageType: z.string().optional(),
  })
  .passthrough();

const tourScheduleStopSchema = z
  .object({
    dayNumber: z.number().int(),
    sequenceWithinDayNumber: z.number().int().optional(),
    date: sailDateStringSchema.optional(),
    startCityCode: z.string().optional(),
    startCityName: z.string().optional(),
    endCityCode: z.string().optional(),
    endCityName: z.string().optional(),
    componentTypeCode: z.string().optional(),
    componentTypeDescription: z.string().optional(),
    componentDescription: z.string().optional(),
    componentShortDescription: z.string().optional(),
    componentProviderCode: z.string().optional(),
    componentProviderName: z.string().optional(),
  })
  .passthrough();

const tourPackageSchema = z
  .object({
    tourCode: z.string(),
    tourTypeCode: z.string().optional(),
    duration: z.number().int().optional(),
    schedule: z.array(tourScheduleStopSchema).optional(),
  })
  .passthrough();

const cabinOptionSchema = z
  .object({
    stateroomCategoryCode: z.string(),
    stateroomSuperCategory: z.string().optional(),
    pricePerGuest: z.number(),
    currency: z.string().optional(),
  })
  .passthrough();

const sailingPackageSchema = z
  .object({
    brandCode: brandCodeSchema,
    cruiseOnly: z.boolean().optional(),
    duration: z.number().int(),
    shipCode: z.string(),
    sailDate: sailDateStringSchema,
    sailingStatus: z.string().optional(),
    packageCode: z.string(),
    shipName: z.string().optional(),
    packageDescription: z.string().optional(),
    regionCode: z.string().optional(),
    subRegionCode: z.string().optional(),
    sailingItinerary: sailingItinerarySchema.optional(),
    tours: z.array(tourPackageSchema).optional(),
    cabinOptions: z.array(cabinOptionSchema).optional(),
    bookingUrl: z.string().optional(),
  })
  .passthrough();

export const sailingPackageResponseSchema = z
  .object({
    status: vpsStatusSchema,
    sailingPackages: z.array(sailingPackageSchema),
  })
  .passthrough();

export type SailingPackageResponse = z.infer<typeof sailingPackageResponseSchema>;
