import { formatISO } from "date-fns";
import { CaptchaEncounteredError, ScrapeFailureError } from "@/api/errors";
import { successEnvelope } from "@/api/helpers/envelope";
import type { FemaSubmissionRequest, FemaSubmissionResponse } from "@/api/schemas/fema-submission";
import { prisma } from "@/lib/db/client";
import { getLogger } from "@/lib/logging";
import { CaptchaError } from "@/scraper/errors";
import { submitFemaApplication } from "@/scraper/flows/fema-submission";
import { runWithSession } from "@/scraper/pool";

const logger = getLogger({ name: "services/fema-submission" });

/**
 * Submits a FEMA disaster assistance application by driving a Steel +
 * Stagehand browser session through all form phases. Persists a
 * FemaSubmission record on both success and failure for auditability.
 */
export async function submitApplication(
  request: FemaSubmissionRequest
): Promise<FemaSubmissionResponse> {
  const applicantEmail = request.identity.email;
  const disasterNumber = request.preApplication.disasterNumber;

  logger.info(`fema submission start: disaster=${disasterNumber} applicant=${applicantEmail}`);

  try {
    const result = await runWithSession((session) => submitFemaApplication(session, request));

    const record = await prisma.femaSubmission.create({
      data: {
        disasterNumber,
        applicantEmail,
        status: "submitted",
        confirmationNumber: result.confirmationNumber ?? null,
        payload: {
          input: request,
          pagesCompleted: result.pagesCompleted,
        },
      },
    });
    logger.info(
      `fema submission success: id=${record.id} confirmation=${result.confirmationNumber ?? "unknown"} pages=${result.pagesCompleted}`
    );

    return successEnvelope({
      submissionId: record.id,
      confirmationNumber: result.confirmationNumber,
      pagesCompleted: result.pagesCompleted,
      submittedAt: formatISO(new Date()),
    }) as FemaSubmissionResponse;
  } catch (err) {
    // Persist the failure record before re-throwing so ops can replay it.
    try {
      const record = await prisma.femaSubmission.create({
        data: {
          disasterNumber,
          applicantEmail,
          status: "error",
          payload: {
            input: request,
            error: String(err),
          },
        },
      });
      logger.warn(`fema submission error persisted: id=${record.id}`);
    } catch (dbErr) {
      logger.warn(`failed to persist fema submission error record: ${String(dbErr)}`);
    }

    if (err instanceof CaptchaError) {
      throw new CaptchaEncounteredError();
    }
    throw new ScrapeFailureError(err instanceof Error ? err.message : String(err));
  }
}
