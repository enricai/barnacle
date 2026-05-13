"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.superCategoryPricingRoute = superCategoryPricingRoute;
const super_category_pricing_1 = require("@/api/schemas/super-category-pricing");
const pricing_1 = require("@/services/pricing");
async function superCategoryPricingRoute(app) {
    app.post("/v1/partner-pricing/super-category-pricing", {
        onRequest: [app.authenticate],
        schema: {
            body: super_category_pricing_1.superCategoryPricingRequestSchema,
            response: { 200: super_category_pricing_1.superCategoryPricingResponseSchema },
        },
    }, async (request) => {
        return (0, pricing_1.getSuperCategoryPricing)(request.body);
    });
}
//# sourceMappingURL=super-category-pricing.js.map