"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.sailingPackageRoute = sailingPackageRoute;
const sailing_package_1 = require("@/api/schemas/sailing-package");
const sailing_catalog_1 = require("@/services/sailing-catalog");
/**
 * `GET /v1/catalog/sailing-package` — discover sailings. RC uses query
 * strings here; our inbound schema transforms the stringy `shipCodes`
 * and `includeTourPackages` into proper types before handing to the
 * service.
 */
async function sailingPackageRoute(app) {
    app.get("/v1/catalog/sailing-package", {
        onRequest: [app.authenticate],
        schema: {
            querystring: sailing_package_1.sailingPackageQueryStringSchema,
            response: { 200: sailing_package_1.sailingPackageResponseSchema },
        },
    }, async (request) => {
        return (0, sailing_catalog_1.getSailingPackages)(request.query);
    });
}
//# sourceMappingURL=sailing-package.js.map