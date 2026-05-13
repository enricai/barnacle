import type { FastifyInstance } from "fastify";

import {
  priceChangesSuperCategoryRequestSchema,
  priceChangesSuperCategoryResponseSchema,
} from "@/api/schemas/price-changes-super-category";
import { getPriceChanges } from "@/services/price-changes";

export async function priceChangesSuperCategoryRoute(app: FastifyInstance): Promise<void> {
  app.post(
    "/v1/pricing-snapshot/price-changes/super-category",
    {
      onRequest: [app.authenticate],
      schema: {
        body: priceChangesSuperCategoryRequestSchema,
        response: { 200: priceChangesSuperCategoryResponseSchema },
      },
    },
    async (request) => {
      const body = request.body as { fromDateTime: string };
      return getPriceChanges(body.fromDateTime, "super-category");
    }
  );
}
