import type { FastifyInstance } from "fastify";
import type { z } from "zod";

import { searchRequestSchema, searchResponseSchema } from "@/api/schemas/search";
import { getSailingPackages } from "@/services/sailing-catalog";

type SearchRequestBody = z.infer<typeof searchRequestSchema>;

/**
 * `POST /v1/search` — JSON-body counterpart to the query-string
 * `GET /v1/catalog/sailing-package` route. TASKS.md Task 8 specifies
 * a POST search endpoint; VPS parity dictated the GET variant for
 * client-compat, so both live side-by-side and share the service layer.
 */
export async function searchRoute(app: FastifyInstance): Promise<void> {
  app.post<{ Body: SearchRequestBody }>(
    "/v1/search",
    {
      onRequest: [app.authenticate],
      schema: {
        body: searchRequestSchema,
        response: { 200: searchResponseSchema },
      },
    },
    async (request) => {
      return getSailingPackages(request.body);
    }
  );
}
