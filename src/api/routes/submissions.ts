import type { FastifyInstance } from "fastify";

import { successEnvelope } from "@/api/helpers/envelope";
import type {
  ReconciliationRow as ReconciliationRowResponse,
  SubmissionsQuerystring,
} from "@/api/schemas/submissions";
import { submissionsQuerystringSchema, submissionsResponseSchema } from "@/api/schemas/submissions";
import { readDurableReconciliationRows } from "@/lib/telemetry/reconciliation-source";
import { queryReconciliationRows } from "@/lib/telemetry/submission-query";
import type { ReconciliationRow } from "@/lib/telemetry/submission-reader";

/**
 * Injectable options for `submissionsRoutes`. The sink path is passed in at
 * registration time (mirrors `pluginsIntrospectionRoutes`'s `report`
 * injection) so the route can be tested against a temp NDJSON file instead
 * of the real `.barnacle/submissions.ndjson`.
 */
export interface SubmissionsRoutesOptions {
  /** Override the sink path; defaults to `config.telemetry.submissionsNdjsonPath` when omitted. */
  sinkPath?: string;
}

/**
 * Narrows the reader's fold output (which carries the raw `beaconTs`/
 * `beaconDurationMs` fold detail) down to the wire contract in
 * `reconciliationRowSchema`, renaming `beaconTrackingUrl` to `trackingUrl`.
 */
function toResponseRow(row: ReconciliationRow): ReconciliationRowResponse {
  const {
    beaconTrackingUrl,
    beaconTs: _beaconTs,
    beaconDurationMs: _beaconDurationMs,
    ...rest
  } = row;
  return { ...rest, trackingUrl: beaconTrackingUrl };
}

/**
 * Exposes the reconciled submit+beacon rows behind authentication, so
 * attribution can join runs to the Appcast CPA report over HTTP instead of
 * re-parsing raw NDJSON. Kept out of `healthRoutes` because this payload
 * carries applicant-run identifiers (`vivclid`, job reference) — strictly
 * more sensitive than the plugin-load report `pluginsIntrospectionRoutes`
 * already gates behind auth.
 */
export async function submissionsRoutes(
  app: FastifyInstance,
  options: SubmissionsRoutesOptions = {}
): Promise<void> {
  const { sinkPath } = options;

  app.get<{ Querystring: SubmissionsQuerystring }>(
    "/v1/submissions",
    {
      onRequest: [app.authenticate],
      schema: {
        querystring: submissionsQuerystringSchema,
        response: { 200: submissionsResponseSchema },
      },
    },
    async (request) => {
      const { limit, offset, ...filter } = request.query;
      const rows = await readDurableReconciliationRows({
        sinkPath,
        from: filter.from,
        to: filter.to,
      });
      const matched = queryReconciliationRows(rows, filter);
      const paged = matched.slice(offset, offset + limit);

      return successEnvelope({
        submissions: paged.map(toResponseRow),
        total: matched.length,
      });
    }
  );
}
