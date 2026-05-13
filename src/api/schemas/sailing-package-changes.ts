import { z } from "zod";

import {
  dateTimeRangeSchema,
  isoDateTimeSchema,
  sailingKeySchema,
  vpsStatusSchema,
} from "@/api/schemas/common";

/**
 * Request body for `POST /v1/catalog/sailing-package-changes`. Clients
 * submit `{ agencyId, fromDateTime }` and receive back the sailing keys
 * whose itinerary/metadata changed since that timestamp.
 */
export const sailingPackageChangesRequestSchema = z
  .object({
    agencyId: z.string(),
    fromDateTime: isoDateTimeSchema,
  })
  .strict();

export type SailingPackageChangesRequest = z.infer<typeof sailingPackageChangesRequestSchema>;

export const sailingPackageChangesResponseSchema = z
  .object({
    status: vpsStatusSchema,
    keys: z.array(sailingKeySchema),
    dateTimeRange: dateTimeRangeSchema.optional(),
  })
  .passthrough();

export type SailingPackageChangesResponse = z.infer<typeof sailingPackageChangesResponseSchema>;
