import type { FastifyInstance } from "fastify";

import {
  sailingPackageChangesRequestSchema,
  sailingPackageChangesResponseSchema,
} from "@/api/schemas/sailing-package-changes";
import { getSailingPackageChanges } from "@/services/sailing-catalog";

/**
 * `POST /v1/catalog/sailing-package-changes` — delta keys of sailings
 * whose itinerary/metadata changed since `fromDateTime`.
 */
export async function sailingPackageChangesRoute(app: FastifyInstance): Promise<void> {
  app.post(
    "/v1/catalog/sailing-package-changes",
    {
      onRequest: [app.authenticate],
      schema: {
        body: sailingPackageChangesRequestSchema,
        response: { 200: sailingPackageChangesResponseSchema },
      },
    },
    async (request) => {
      const body = request.body as { fromDateTime: string };
      return getSailingPackageChanges(body.fromDateTime);
    }
  );
}
