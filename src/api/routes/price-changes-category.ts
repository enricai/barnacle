import type { FastifyInstance } from "fastify";

import {
  priceChangesCategoryRequestSchema,
  priceChangesCategoryResponseSchema,
} from "@/api/schemas/price-changes-category";
import { getPriceChanges } from "@/services/price-changes";

export async function priceChangesCategoryRoute(app: FastifyInstance): Promise<void> {
  app.post(
    "/v1/pricing-snapshot/price-changes/category",
    {
      onRequest: [app.authenticate],
      schema: {
        body: priceChangesCategoryRequestSchema,
        response: { 200: priceChangesCategoryResponseSchema },
      },
    },
    async (request) => {
      const body = request.body as { fromDateTime: string };
      return getPriceChanges(body.fromDateTime, "category");
    }
  );
}
