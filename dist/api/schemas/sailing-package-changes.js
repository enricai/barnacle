"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.sailingPackageChangesResponseSchema = exports.sailingPackageChangesRequestSchema = void 0;
const zod_1 = require("zod");
const common_1 = require("@/api/schemas/common");
/**
 * Request body for `POST /v1/catalog/sailing-package-changes`. Clients
 * submit `{ agencyId, fromDateTime }` and receive back the sailing keys
 * whose itinerary/metadata changed since that timestamp.
 */
exports.sailingPackageChangesRequestSchema = zod_1.z
    .object({
    agencyId: zod_1.z.string(),
    fromDateTime: common_1.isoDateTimeSchema,
})
    .strict();
exports.sailingPackageChangesResponseSchema = zod_1.z
    .object({
    status: common_1.vpsStatusSchema,
    keys: zod_1.z.array(common_1.sailingKeySchema),
    dateTimeRange: common_1.dateTimeRangeSchema.optional(),
})
    .passthrough();
//# sourceMappingURL=sailing-package-changes.js.map