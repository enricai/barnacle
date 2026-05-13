"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.promotionDetailsRoute = promotionDetailsRoute;
const promotion_details_1 = require("@/api/schemas/promotion-details");
const promotions_1 = require("@/services/promotions");
async function promotionDetailsRoute(app) {
    app.post("/v1/promotion/promotion-details", {
        onRequest: [app.authenticate],
        schema: {
            body: promotion_details_1.promotionDetailsRequestSchema,
            response: { 200: promotion_details_1.promotionDetailsResponseSchema },
        },
    }, async (request) => {
        return (0, promotions_1.getPromotionDetails)(request.body);
    });
}
//# sourceMappingURL=promotion-details.js.map