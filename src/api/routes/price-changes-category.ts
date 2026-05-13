import type { FastifyInstance } from "fastify";
import type { z } from "zod";

import {
  priceChangesCategoryRequestSchema,
  priceChangesCategoryResponseSchema,
} from "@/api/schemas/price-changes-category";
import { getPriceChanges } from "@/services/price-changes";

type Body = z.infer<typeof priceChangesCategoryRequestSchema>;

export async function priceChangesCategoryRoute(app: FastifyInstance): Promise<void> {
  app.post<{ Body: Body }>(
    "/v1/pricing-snapshot/price-changes/category",
    {
      onRequest: [app.authenticate],
      schema: {
        body: priceChangesCategoryRequestSchema,
        response: { 200: priceChangesCategoryResponseSchema },
      },
    },
    async (request) => {
      return getPriceChanges(request.body.fromDateTime, "category");
    }
  );
}
