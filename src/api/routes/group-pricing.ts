import type { FastifyInstance } from "fastify";
import type { z } from "zod";

import { groupPricingRequestSchema, groupPricingResponseSchema } from "@/api/schemas/group-pricing";
import { getGroupPricing } from "@/services/pricing";

type Body = z.infer<typeof groupPricingRequestSchema>;

export async function groupPricingRoute(app: FastifyInstance): Promise<void> {
  app.post<{ Body: Body }>(
    "/v1/partner-pricing/group-pricing",
    {
      onRequest: [app.authenticate],
      schema: {
        body: groupPricingRequestSchema,
        response: { 200: groupPricingResponseSchema },
      },
    },
    async (request) => {
      return getGroupPricing(request.body);
    }
  );
}
