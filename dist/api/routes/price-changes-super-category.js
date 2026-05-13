"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.priceChangesSuperCategoryRoute = priceChangesSuperCategoryRoute;
const price_changes_super_category_1 = require("@/api/schemas/price-changes-super-category");
const price_changes_1 = require("@/services/price-changes");
async function priceChangesSuperCategoryRoute(app) {
    app.post("/v1/pricing-snapshot/price-changes/super-category", {
        onRequest: [app.authenticate],
        schema: {
            body: price_changes_super_category_1.priceChangesSuperCategoryRequestSchema,
            response: { 200: price_changes_super_category_1.priceChangesSuperCategoryResponseSchema },
        },
    }, async (request) => {
        const body = request.body;
        return (0, price_changes_1.getPriceChanges)(body.fromDateTime, "super-category");
    });
}
//# sourceMappingURL=price-changes-super-category.js.map