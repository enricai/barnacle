import type { FastifyInstance } from "fastify";
import type { z } from "zod";

import {
  sailingPackageChangesRequestSchema,
  sailingPackageChangesResponseSchema,
} from "@/api/schemas/sailing-package-changes";
import { getSailingPackageChanges } from "@/services/sailing-catalog";

type Body = z.infer<typeof sailingPackageChangesRequestSchema>;

/**
 * `POST /v1/catalog/sailing-package-changes` — delta keys of sailings
 * whose itinerary/metadata changed since `fromDateTime`.
 */
export async function sailingPackageChangesRoute(app: FastifyInstance): Promise<void> {
  app.post<{ Body: Body }>(
    "/v1/catalog/sailing-package-changes",
    {
      onRequest: [app.authenticate],
      schema: {
        body: sailingPackageChangesRequestSchema,
        response: { 200: sailingPackageChangesResponseSchema },
      },
    },
    async (request) => {
      return getSailingPackageChanges(request.body.fromDateTime);
    }
  );
}
