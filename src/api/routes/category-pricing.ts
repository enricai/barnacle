import type { FastifyInstance } from "fastify";
import type { z } from "zod";

import {
  categoryPricingRequestSchema,
  categoryPricingResponseSchema,
} from "@/api/schemas/category-pricing";
import { getCategoryPricing } from "@/services/pricing";

type Body = z.infer<typeof categoryPricingRequestSchema>;

export async function categoryPricingRoute(app: FastifyInstance): Promise<void> {
  app.post<{ Body: Body }>(
    "/v1/partner-pricing/category-pricing",
    {
      onRequest: [app.authenticate],
      schema: {
        body: categoryPricingRequestSchema,
        response: { 200: categoryPricingResponseSchema },
      },
    },
    async (request) => {
      return getCategoryPricing(request.body);
    }
  );
}
