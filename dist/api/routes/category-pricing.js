"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.categoryPricingRoute = categoryPricingRoute;
const category_pricing_1 = require("@/api/schemas/category-pricing");
const pricing_1 = require("@/services/pricing");
async function categoryPricingRoute(app) {
    app.post("/v1/partner-pricing/category-pricing", {
        onRequest: [app.authenticate],
        schema: {
            body: category_pricing_1.categoryPricingRequestSchema,
            response: { 200: category_pricing_1.categoryPricingResponseSchema },
        },
    }, async (request) => {
        return (0, pricing_1.getCategoryPricing)(request.body);
    });
}
//# sourceMappingURL=category-pricing.js.map