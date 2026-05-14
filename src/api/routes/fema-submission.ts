import type { FastifyInstance } from "fastify";

import {
  type FemaSubmissionRequest,
  femaSubmissionRequestSchema,
  femaSubmissionResponseSchema,
} from "@/api/schemas/fema-submission";
import { submitApplication } from "@/services/fema-submission";

/**
 * Registers the FEMA disaster assistance submission endpoint. The route
 * accepts a fully structured application payload and drives a Steel +
 * Stagehand browser session through all form phases, returning the
 * confirmation number on success.
 */
export async function femaSubmissionRoute(app: FastifyInstance): Promise<void> {
  app.post<{ Body: FemaSubmissionRequest }>(
    "/v1/fema/submit",
    {
      onRequest: [app.authenticate],
      schema: {
        body: femaSubmissionRequestSchema,
        response: { 200: femaSubmissionResponseSchema },
      },
    },
    async (request) => submitApplication(request.body)
  );
}
