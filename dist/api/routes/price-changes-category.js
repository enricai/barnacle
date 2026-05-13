"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.priceChangesCategoryRoute = priceChangesCategoryRoute;
const price_changes_category_1 = require("@/api/schemas/price-changes-category");
const price_changes_1 = require("@/services/price-changes");
async function priceChangesCategoryRoute(app) {
    app.post("/v1/pricing-snapshot/price-changes/category", {
        onRequest: [app.authenticate],
        schema: {
            body: price_changes_category_1.priceChangesCategoryRequestSchema,
            response: { 200: price_changes_category_1.priceChangesCategoryResponseSchema },
        },
    }, async (request) => {
        const body = request.body;
        return (0, price_changes_1.getPriceChanges)(body.fromDateTime, "category");
    });
}
//# sourceMappingURL=price-changes-category.js.map