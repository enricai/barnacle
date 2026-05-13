"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.sailingPackageChangesRoute = sailingPackageChangesRoute;
const sailing_package_changes_1 = require("@/api/schemas/sailing-package-changes");
const sailing_catalog_1 = require("@/services/sailing-catalog");
/**
 * `POST /v1/catalog/sailing-package-changes` — delta keys of sailings
 * whose itinerary/metadata changed since `fromDateTime`.
 */
async function sailingPackageChangesRoute(app) {
    app.post("/v1/catalog/sailing-package-changes", {
        onRequest: [app.authenticate],
        schema: {
            body: sailing_package_changes_1.sailingPackageChangesRequestSchema,
            response: { 200: sailing_package_changes_1.sailingPackageChangesResponseSchema },
        },
    }, async (request) => {
        const body = request.body;
        return (0, sailing_catalog_1.getSailingPackageChanges)(body.fromDateTime);
    });
}
//# sourceMappingURL=sailing-package-changes.js.map