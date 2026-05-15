import { getLogger } from "@/lib/logging";
import type { BrowserSession } from "@/scraper/session";
import type { SitePluginContext, SitePluginResult } from "@/site-plugin";
import type { FemaSubmissionResult } from "@/sites/fema/flow";
import { submitFemaApplication } from "@/sites/fema/flow";
import type { FemaSubmissionRequest } from "@/sites/fema/schema";

const logger = getLogger({ name: "sites/fema/service" });

/**
 * Drives the FEMA form automation and returns the result for core to wrap
 * in the response envelope. All DB persistence is deferred to dispatch().
 */
export async function execute(
  payload: FemaSubmissionRequest,
  session: BrowserSession,
  context: SitePluginContext
): Promise<SitePluginResult<FemaSubmissionResult>> {
  logger.info(
    `fema submission start: disaster=${payload.preApplication.disasterNumber} applicant=${payload.identity.email}`
  );

  const data = await submitFemaApplication(session, payload, context.baseUrl);

  logger.info(
    `fema submission success: confirmation=${data.confirmationNumber ?? "unknown"} pages=${data.pagesCompleted}`
  );

  // Redact PII fields before audit persistence — SSN and password must not
  // reach the DB in plaintext.
  const { identity, ...safePayload } = payload;
  const { password: _pw, ...safeIdentity } = identity;
  const { applicant, ...restPayload } = safePayload;
  const { ssn: _ssn, ...safeApplicant } = applicant;

  return {
    data,
    auditPayload: {
      payload: { ...restPayload, identity: safeIdentity, applicant: safeApplicant },
      result: data,
    },
  };
}
