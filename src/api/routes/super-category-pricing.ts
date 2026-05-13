import type { FastifyInstance } from "fastify";
import type { z } from "zod";

import {
  superCategoryPricingRequestSchema,
  superCategoryPricingResponseSchema,
} from "@/api/schemas/super-category-pricing";
import { getSuperCategoryPricing } from "@/services/pricing";

type Body = z.infer<typeof superCategoryPricingRequestSchema>;

export async function superCategoryPricingRoute(app: FastifyInstance): Promise<void> {
  app.post<{ Body: Body }>(
    "/v1/partner-pricing/super-category-pricing",
    {
      onRequest: [app.authenticate],
      schema: {
        body: superCategoryPricingRequestSchema,
        response: { 200: superCategoryPricingResponseSchema },
      },
    },
    async (request) => {
      return getSuperCategoryPricing(request.body);
    }
  );
}
