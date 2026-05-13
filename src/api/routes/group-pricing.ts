import type { FastifyInstance } from "fastify";

import { groupPricingRequestSchema, groupPricingResponseSchema } from "@/api/schemas/group-pricing";
import { getGroupPricing } from "@/services/pricing";

export async function groupPricingRoute(app: FastifyInstance): Promise<void> {
  app.post(
    "/v1/partner-pricing/group-pricing",
    {
      onRequest: [app.authenticate],
      schema: {
        body: groupPricingRequestSchema,
        response: { 200: groupPricingResponseSchema },
      },
    },
    async (request) => {
      return getGroupPricing(request.body as never);
    }
  );
}
