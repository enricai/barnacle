"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.sailingPackageResponseSchema = exports.sailingPackageSchema = exports.tourPackageSchema = exports.tourScheduleStopSchema = exports.sailingItinerarySchema = exports.itineraryStopSchema = exports.sailingPackageQueryStringSchema = exports.sailingPackageRequestSchema = void 0;
const zod_1 = require("zod");
const common_1 = require("@/api/schemas/common");
/**
 * Request parameters accepted by `GET /v1/catalog/sailing-package`. RC uses
 * query strings; we normalize to Zod-parsed, camelCase fields before passing
 * them into the service layer. `shipCodes` is a comma-separated list on the
 * wire but exposed as a proper array.
 */
exports.sailingPackageRequestSchema = zod_1.z
    .object({
    brandCode: common_1.brandCodeSchema,
    fromSailDate: common_1.sailDateStringSchema,
    toSailDate: common_1.sailDateStringSchema,
    shipCodes: zod_1.z.array(zod_1.z.string()).optional(),
    includeTourPackages: zod_1.z.boolean().optional().default(false),
})
    .strict();
/**
 * Inbound query-string variant — same fields but `shipCodes` is a string and
 * `includeTourPackages` may be a string like `"true"`. Routes apply this
 * before handing to services.
 */
exports.sailingPackageQueryStringSchema = zod_1.z
    .object({
    brandCode: common_1.brandCodeSchema,
    fromSailDate: common_1.sailDateStringSchema,
    toSailDate: common_1.sailDateStringSchema,
    shipCodes: zod_1.z.string().optional(),
    includeTourPackages: zod_1.z.union([zod_1.z.boolean(), zod_1.z.string()]).optional(),
})
    .transform((input) => ({
    brandCode: input.brandCode,
    fromSailDate: input.fromSailDate,
    toSailDate: input.toSailDate,
    shipCodes: input.shipCodes
        ? input.shipCodes
            .split(",")
            .map((code) => code.trim())
            .filter(Boolean)
        : undefined,
    includeTourPackages: typeof input.includeTourPackages === "boolean"
        ? input.includeTourPackages
        : input.includeTourPackages === "true",
}));
/**
 * One entry in a sailing's itinerary schedule. RC exposes a deep itinerary
 * tree; we stay lenient (passthrough) because the doc explicitly allows
 * new enum values and fields.
 */
exports.itineraryStopSchema = zod_1.z
    .object({
    dayNumber: zod_1.z.number().int(),
    date: common_1.sailDateStringSchema.optional(),
    portCode: zod_1.z.string().optional(),
    portName: zod_1.z.string().optional(),
    countryName: zod_1.z.string().optional().nullable(),
    activity: zod_1.z.string().optional(),
    arrivalTime: zod_1.z.string().optional().nullable(),
    departureTime: zod_1.z.string().optional().nullable(),
})
    .passthrough();
exports.sailingItinerarySchema = zod_1.z
    .object({
    itineraryCode: zod_1.z.string().optional(),
    duration: zod_1.z.number().int().optional(),
    schedule: zod_1.z.array(exports.itineraryStopSchema),
    itineraryType: zod_1.z.string().nullable().optional(),
    voyageType: zod_1.z.string().optional(),
})
    .passthrough();
exports.tourScheduleStopSchema = zod_1.z
    .object({
    dayNumber: zod_1.z.number().int(),
    sequenceWithinDayNumber: zod_1.z.number().int().optional(),
    date: common_1.sailDateStringSchema.optional(),
    startCityCode: zod_1.z.string().optional(),
    startCityName: zod_1.z.string().optional(),
    endCityCode: zod_1.z.string().optional(),
    endCityName: zod_1.z.string().optional(),
    activityCode: zod_1.z.string().optional(),
    activityDescription: zod_1.z.string().optional(),
})
    .passthrough();
exports.tourPackageSchema = zod_1.z
    .object({
    tourCode: zod_1.z.string(),
    tourTypeCode: zod_1.z.string().optional(),
    duration: zod_1.z.number().int().optional(),
    schedule: zod_1.z.array(exports.tourScheduleStopSchema).optional(),
})
    .passthrough();
exports.sailingPackageSchema = zod_1.z
    .object({
    brandCode: common_1.brandCodeSchema,
    cruiseOnly: zod_1.z.boolean().optional(),
    duration: zod_1.z.number().int(),
    shipCode: zod_1.z.string(),
    sailDate: common_1.sailDateStringSchema,
    sailingStatus: zod_1.z.string().optional(),
    packageCode: zod_1.z.string(),
    shipName: zod_1.z.string().optional(),
    packageDescription: zod_1.z.string().optional(),
    regionCode: zod_1.z.string().optional(),
    subRegionCode: zod_1.z.string().optional(),
    sailingItinerary: exports.sailingItinerarySchema.optional(),
    tours: zod_1.z.array(exports.tourPackageSchema).optional(),
})
    .passthrough();
exports.sailingPackageResponseSchema = zod_1.z
    .object({
    status: common_1.vpsStatusSchema,
    sailingPackages: zod_1.z.array(exports.sailingPackageSchema),
})
    .passthrough();
//# sourceMappingURL=sailing-package.js.map