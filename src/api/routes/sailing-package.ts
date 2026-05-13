import type { FastifyInstance } from "fastify";

import {
  sailingPackageQueryStringSchema,
  sailingPackageResponseSchema,
} from "@/api/schemas/sailing-package";
import { getSailingPackages } from "@/services/sailing-catalog";

/**
 * `GET /v1/catalog/sailing-package` — discover sailings. RC uses query
 * strings here; our inbound schema transforms the stringy `shipCodes`
 * and `includeTourPackages` into proper types before handing to the
 * service.
 */
export async function sailingPackageRoute(app: FastifyInstance): Promise<void> {
  app.get(
    "/v1/catalog/sailing-package",
    {
      onRequest: [app.authenticate],
      schema: {
        querystring: sailingPackageQueryStringSchema,
        response: { 200: sailingPackageResponseSchema },
      },
    },
    async (request) => {
      return getSailingPackages(request.query as never);
    }
  );
}
