import type { FastifyInstance } from "fastify";
import type { z } from "zod";

import {
  promotionDetailsRequestSchema,
  promotionDetailsResponseSchema,
} from "@/api/schemas/promotion-details";
import { getPromotionDetails } from "@/services/promotions";

type Body = z.infer<typeof promotionDetailsRequestSchema>;

export async function promotionDetailsRoute(app: FastifyInstance): Promise<void> {
  app.post<{ Body: Body }>(
    "/v1/promotion/promotion-details",
    {
      onRequest: [app.authenticate],
      schema: {
        body: promotionDetailsRequestSchema,
        response: { 200: promotionDetailsResponseSchema },
      },
    },
    async (request) => {
      return getPromotionDetails(request.body);
    }
  );
}
