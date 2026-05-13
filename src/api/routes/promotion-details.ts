import type { FastifyInstance } from "fastify";

import {
  promotionDetailsRequestSchema,
  promotionDetailsResponseSchema,
} from "@/api/schemas/promotion-details";
import { getPromotionDetails } from "@/services/promotions";

export async function promotionDetailsRoute(app: FastifyInstance): Promise<void> {
  app.post(
    "/v1/promotion/promotion-details",
    {
      onRequest: [app.authenticate],
      schema: {
        body: promotionDetailsRequestSchema,
        response: { 200: promotionDetailsResponseSchema },
      },
    },
    async (request) => {
      return getPromotionDetails(request.body as never);
    }
  );
}
