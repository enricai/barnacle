import { z } from "zod";

import { brandCodeSchema, sailDateStringSchema } from "@/api/schemas/common";
import {
  type SailingPackageRequest,
  sailingPackageResponseSchema,
} from "@/api/schemas/sailing-package";

/**
 * VPS super-category codes as exposed by `cruiseSearch_Cruises`'s
 * `stateroomClass.id` + `stateroomClass.content.code`. I/O/B/D are the
 * canonical four; A/C surface for niche cruises (Accessible, Connecting)
 * and are accepted but not advertised.
 */
export const cabinTypeSchema = z.enum(["INTERIOR", "OUTSIDE", "BALCONY", "SUITE"]);
export type CabinType = z.infer<typeof cabinTypeSchema>;

/**
 * Alpha-numeric-uppercase destination code (`CARIB`, `BAHAM`, `ALCAN`, ...).
 * RC's `itinerary.destination.code` uses these 3-6 character tokens.
 */
const destinationCodeSchema = z.string().regex(/^[A-Z0-9]{3,6}$/, {
  message: "destination codes are uppercase alphanumeric (3-6 chars)",
});

/**
 * 3-letter uppercase departure port code (`MIA`, `FLL`, `PCC`, ...). RC's
 * `itinerary.departurePort.code` uses ISO-like tokens.
 */
const departurePortCodeSchema = z.string().regex(/^[A-Z]{3}$/, {
  message: "departure port codes are exactly 3 uppercase letters",
});

const cruiseLengthRangeSchema = z
  .object({
    min: z.number().int().min(1).max(30),
    max: z.number().int().min(1).max(60),
  })
  .refine((r) => r.min <= r.max, {
    message: "cruiseLengthRange.min must be <= cruiseLengthRange.max",
  });

/**
 * POST `/v1/search` body — the free-form sailing search originally envisioned
 * in TASKS.md Task 8. Unlike `GET /v1/catalog/sailing-package` (which accepts
 * RC's legacy comma-separated query strings), this route accepts a proper
 * JSON body with native arrays/booleans and the full TASKS.md Task 8 filter
 * set (destinations, departurePorts, cruiseLengthRange, guestCount, cabinType).
 * The schema transforms to the same `SailingPackageRequest` shape so the
 * existing `getSailingPackages()` service can handle both entry points with
 * zero duplication.
 */
export const searchRequestSchema = z
  .object({
    brandCode: brandCodeSchema.default("R"),
    fromSailDate: sailDateStringSchema,
    toSailDate: sailDateStringSchema,
    shipCodes: z.array(z.string().min(1).max(4)).max(10).optional(),
    destinations: z.array(destinationCodeSchema).max(10).optional(),
    departurePorts: z.array(departurePortCodeSchema).max(10).optional(),
    cruiseLengthRange: cruiseLengthRangeSchema.optional(),
    guestCount: z.number().int().min(1).max(8).optional(),
    cabinType: cabinTypeSchema.optional(),
    includeTourPackages: z.boolean().optional().default(false),
  })
  .strict()
  .transform(
    (input): SailingPackageRequest => ({
      brandCode: input.brandCode,
      fromSailDate: input.fromSailDate,
      toSailDate: input.toSailDate,
      shipCodes: input.shipCodes,
      destinations: input.destinations,
      departurePorts: input.departurePorts,
      cruiseLengthRange: input.cruiseLengthRange,
      guestCount: input.guestCount,
      cabinType: input.cabinType,
      includeTourPackages: input.includeTourPackages,
    })
  );

export type SearchRequestInput = z.input<typeof searchRequestSchema>;

export const searchResponseSchema = sailingPackageResponseSchema;
