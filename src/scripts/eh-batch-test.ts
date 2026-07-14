/**
 * Batch test for the Encompass Health HTTP hot path. Submits to every
 * test URL from the spec with a fresh testmail address per job, then
 * polls each inbox for a confirmation email from Oracle HCM.
 *
 * Usage: npx tsx --env-file=.env src/scripts/eh-batch-test.ts
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { MetricsCollector } from "@/lib/dispatch-metrics";
import { getLogger } from "@/lib/logging";
import type { EncompasshealthPayload } from "@/sites/encompasshealth/contract";
import { runEncompasshealthHttpFlow } from "@/sites/encompasshealth/flows/http-flow";
import type { SubmitOutcome } from "@/testing/batch-email-confirmation";
import { runBatchEmailConfirmation } from "@/testing/batch-email-confirmation";
import { type BatchJobVerdict, renderBatchReport } from "@/testing/batch-report";
import { TEST_PERSONA } from "@/testing/persona-fixture";
import { loadTestResume } from "@/testing/resume-fixture";
import { allocateTestmailInbox, pollTestmailInbox } from "@/testmail/client";

const logger = getLogger({ name: "eh-batch-test" });

const SPEC_PATH = resolve(__dirname, "../../BarnacleEncompassHealthSpec.md");

function extractUrlsFromSpec(): string[] {
  const spec = readFileSync(SPEC_PATH, "utf8");
  const urls: string[] = [];
  for (const line of spec.split("\n")) {
    const match = line.match(
      /(https:\/\/careers\.encompasshealth\.com\/job\/\?[^\s]+j-[A-Za-z0-9]+[^\s]*)/
    );
    if (match) {
      urls.push(match[1]!);
    }
  }
  return [...new Set(urls)];
}

function extractReqNum(clickUrl: string): string {
  const match = clickUrl.match(/j-([A-Za-z0-9]+)/);
  if (!match) {
    throw new Error(`cannot extract job ID from: ${clickUrl}`);
  }
  return match[1]!;
}

interface EhJob {
  url: string;
  reqNum: string;
}

async function main(): Promise<void> {
  const urls = extractUrlsFromSpec();
  logger.info(`found ${urls.length} test URLs in spec`);

  const resume = loadTestResume();
  const jobs: EhJob[] = urls.map((url) => ({ url, reqNum: extractReqNum(url) }));

  const results = await runBatchEmailConfirmation<EhJob, BatchJobVerdict>(jobs, {
    allocateInbox: () => allocateTestmailInbox(),
    submit: async (job, inbox): Promise<SubmitOutcome> => {
      const payload: EncompasshealthPayload = {
        JobId: `test-${job.reqNum}`,
        BaseUrl: "https://careers.encompasshealth.com",
        ClickUrl: job.url,
        FirstName: TEST_PERSONA.FirstName,
        LastName: TEST_PERSONA.LastName,
        Email: inbox.address,
        Phone: TEST_PERSONA.Phone,
        AddressLine: TEST_PERSONA.Address.Line1,
        City: TEST_PERSONA.Address.City,
        State: TEST_PERSONA.Address.StateAbbreviation,
        PostalCode: TEST_PERSONA.Address.PostalCode,
        Country: TEST_PERSONA.Address.CountryName,
        County: TEST_PERSONA.Address.County,
        Resume: resume.buffer,
        ResumeContentType: resume.contentType,
        ResumeFilename: resume.filename,
        ResumeBase64: resume.base64,
        Answers: {
          WorkAuthorization: "No",
          LegallyEligibleToWorkUS: "Yes",
          CanPerformJobFunctions: "Yes",
          PreviouslyEmployedAtEncompass: "No",
          EverSanctionedOrOnProbation: "No",
          EverTerminated: "No",
          EverExcludedFromFederalProgram: "No",
          Gender: "Prefer not to say",
          Degree: "Nursing",
          EducationLevel: "Bachelor's Degree",
          SignatureFullName: TEST_PERSONA.SignatureName,
          VisaSponsorship: "NA",
          NonCompete: "No",
          OIGGSAOFACExcluded: "No",
          FormerEmployee: "Not Applicable",
          CurrentNonEmployeeId: "NA",
          OtherOpportunities: "Yes",
          RelatedToEmployee: "No",
          MeetsMinimumAge: "Yes",
          AppliedToSanfordOrGoodSamaritanLast6Months: "No",
          HasOrWillObtainLicense: "Yes",
          ReferredByCurrentSanfordOrGoodSamaritanEmployee: "No",
        },
      };
      const t0 = Date.now();
      try {
        const result = await runEncompasshealthHttpFlow(
          payload,
          job.reqNum,
          new MetricsCollector()
        );
        const durationMs = Date.now() - t0;
        if (result.data.verified) {
          return { ok: true, inbox, durationMs };
        }
        return { ok: false, error: "verified=false", durationMs };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
          durationMs: Date.now() - t0,
        };
      }
    },
    pollEmail: async (inbox) => {
      const t0 = Date.now();
      try {
        const msg = await pollTestmailInbox({ inbox, timeoutMs: 90_000 });
        return { received: true, message: msg, waitMs: Date.now() - t0 };
      } catch {
        return { received: false, waitMs: Date.now() - t0 };
      }
    },
    mapVerdict: (job, submitOutcome, pollOutcome) => ({
      jobId: job.reqNum,
      submitStatus: submitOutcome.ok ? "PASS" : "FAIL",
      submitDurationMs: submitOutcome.durationMs,
      emailReceived: pollOutcome?.received ?? false,
      emailSubject: pollOutcome?.received ? pollOutcome.message.subject : undefined,
      error: submitOutcome.ok ? undefined : submitOutcome.error,
    }),
    concurrency: 1,
  });

  const passed = results.filter((r) => r.submitStatus === "PASS");
  const failed = results.filter((r) => r.submitStatus === "FAIL");
  logger.info(`final: ${passed.length} submitted, ${failed.length} failed`);
  // process.stdout.write preserves markdown formatting; pino would JSON-stringify it
  process.stdout.write(renderBatchReport(results, { jobIdLabel: "reqNum" }));
}

main().catch((err) => {
  logger.error(`batch failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
