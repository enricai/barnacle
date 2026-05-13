import type { FastifyInstance } from "fastify";

import {
  categoryPricingRequestSchema,
  categoryPricingResponseSchema,
} from "@/api/schemas/category-pricing";
import { getCategoryPricing } from "@/services/pricing";

export async function categoryPricingRoute(app: FastifyInstance): Promise<void> {
  app.post(
    "/v1/partner-pricing/category-pricing",
    {
      onRequest: [app.authenticate],
      schema: {
        body: categoryPricingRequestSchema,
        response: { 200: categoryPricingResponseSchema },
      },
    },
    async (request) => {
      return getCategoryPricing(request.body as never);
    }
  );
}
