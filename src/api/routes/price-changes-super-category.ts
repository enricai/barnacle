import type { FastifyInstance } from "fastify";
import type { z } from "zod";

import {
  priceChangesSuperCategoryRequestSchema,
  priceChangesSuperCategoryResponseSchema,
} from "@/api/schemas/price-changes-super-category";
import { getPriceChanges } from "@/services/price-changes";

type Body = z.infer<typeof priceChangesSuperCategoryRequestSchema>;

export async function priceChangesSuperCategoryRoute(app: FastifyInstance): Promise<void> {
  app.post<{ Body: Body }>(
    "/v1/pricing-snapshot/price-changes/super-category",
    {
      onRequest: [app.authenticate],
      schema: {
        body: priceChangesSuperCategoryRequestSchema,
        response: { 200: priceChangesSuperCategoryResponseSchema },
      },
    },
    async (request) => {
      return getPriceChanges(request.body.fromDateTime, "super-category");
    }
  );
}
