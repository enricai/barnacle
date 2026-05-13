"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.groupPricingRoute = groupPricingRoute;
const group_pricing_1 = require("@/api/schemas/group-pricing");
const pricing_1 = require("@/services/pricing");
async function groupPricingRoute(app) {
    app.post("/v1/partner-pricing/group-pricing", {
        onRequest: [app.authenticate],
        schema: {
            body: group_pricing_1.groupPricingRequestSchema,
            response: { 200: group_pricing_1.groupPricingResponseSchema },
        },
    }, async (request) => {
        return (0, pricing_1.getGroupPricing)(request.body);
    });
}
//# sourceMappingURL=group-pricing.js.map