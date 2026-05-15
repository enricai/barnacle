import { getLogger } from "@/lib/logging";
import type { BrowserSession } from "@/scraper/session";
import type { SitePluginContext, SitePluginResult } from "@/site-plugin";
import type { FemaSubmissionResult } from "@/sites/fema/flow";
import { submitFemaApplication } from "@/sites/fema/flow";
import type { FemaSubmissionRequest } from "@/sites/fema/schema";

const logger = getLogger({ name: "sites/fema/service" });

/**
 * Drives the FEMA form automation and returns the result for core to wrap
 * in a VPS envelope. All DB persistence is deferred to Phase 3's dispatch().
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

  return {
    data,
    auditPayload: { payload, result: data },
  };
}
