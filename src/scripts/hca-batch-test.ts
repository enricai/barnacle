/**
 * Batch live-verify for the HCA HTTP hot path. Reads a newline-delimited list of
 * live HCA job apply URLs (pulled from the prod read replica —
 * `ScrapedJobUrlResolutionCache.resolvedUrl`) and runs each SEQUENTIALLY through
 * the plugin's `executeHttp` DIRECTLY (the pure hot path — no `dispatch()`, so a
 * hot-path failure is never masked by the browser fallback, and no dev server is
 * needed). Each job gets a FRESH testmail inbox (distinct emails). Every job that
 * runs to completion files a REAL application to HCA prod.
 *
 * Usage:
 *   pnpm tsx --env-file=.env src/scripts/hca-batch-test.ts \
 *     [--urls <path>]     (default: scratchpad/hca-batch-urls.txt) \
 *     [--limit <N>]       (default: all) \
 *     [--report <path>]   (default: scratchpad/hca-batch-report.json)
 */

import { readFileSync, writeFileSync } from "node:fs";

import { config } from "@/config";
import { MetricsCollector } from "@/lib/dispatch-metrics";
import { toErrorMessage } from "@/lib/errors";
import { getScriptLogger } from "@/lib/logging";
import type { SitePluginContext } from "@/site-plugin";
import { type HcaPayload, hcaPlugin } from "@/sites/hca/contract";
import { type BatchJobVerdict, renderBatchReport } from "@/testing/batch-report";
import { TEST_PERSONA } from "@/testing/persona-fixture";
import { loadTestResume } from "@/testing/resume-fixture";
import { allocateTestmailInbox } from "@/testmail/client";

const logger = getScriptLogger("hca-batch-test");

const DEFAULT_URLS = "scratchpad/hca-batch-urls.txt";
const DEFAULT_REPORT = "scratchpad/hca-batch-report.json";
/** Per-job wall-clock ceiling — a stuck browser op must not freeze the whole
 *  sequential batch. Normal jobs run ~50s; 5 min is a generous timeout. */
const JOB_TIMEOUT_MS = 300_000;

function parseArgs(): { urlsPath: string; limit: number | null; reportPath: string } {
  const args = process.argv.slice(2);
  let urlsPath = DEFAULT_URLS;
  let limit: number | null = null;
  let reportPath = DEFAULT_REPORT;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--urls" && args[i + 1]) urlsPath = args[++i]!;
    else if (args[i] === "--limit" && args[i + 1]) limit = Number(args[++i]);
    else if (args[i] === "--report" && args[i + 1]) reportPath = args[++i]!;
  }
  return { urlsPath, limit, reportPath };
}

/** Extract the numeric job id from a `.../jobs/<num>-slug?...` URL for the report row. */
function jobIdOf(url: string): string {
  const m = /\/jobs\/(\d+)-/.exec(url);
  return m ? m[1]! : url.slice(0, 40);
}

/** Build the applicant payload: TEST_PERSONA identity + a unique inbox + fixture resume. */
function buildPayload(email: string): HcaPayload {
  const resume = loadTestResume();
  return {
    FirstName: TEST_PERSONA.FirstName,
    LastName: TEST_PERSONA.LastName,
    Email: email,
    MobilePhone: TEST_PERSONA.Phone,
    AddressLine1: TEST_PERSONA.Address.Line1,
    City: TEST_PERSONA.Address.City,
    State: TEST_PERSONA.Address.StateName,
    PostalCode: TEST_PERSONA.Address.PostalCode,
    Country: TEST_PERSONA.Address.CountryName,
    Resume: resume.buffer,
    ResumeFilename: resume.filename,
    ResumeContentType: resume.contentType,
  };
}

/** Per-job verdict with HCA-specific detail retained in the JSON artifact. */
interface HcaVerdict extends BatchJobVerdict {
  jobUrl: string;
  inboxAddress: string;
  progressPercentage: number | null;
  formCompleteUrl: string | null;
}

async function main(): Promise<void> {
  const { urlsPath, limit, reportPath } = parseArgs();

  const allUrls = readFileSync(urlsPath, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("https://"));
  const urls = limit != null ? allUrls.slice(0, limit) : allUrls;

  logger.info(
    `hca-batch-test: ${urls.length} job(s) — SEQUENTIAL, FULL SUBMIT (real applications). ` +
      "Each files a real prod app with a fresh testmail inbox."
  );

  const verdicts: HcaVerdict[] = [];

  for (const [i, url] of urls.entries()) {
    const jobId = jobIdOf(url);
    const inbox = allocateTestmailInbox();
    const payload = buildPayload(inbox.address);
    const context: SitePluginContext = {
      baseUrl: url,
      logger,
      config,
      requestId: `hca-batch-${jobId}-${inbox.tag}`,
      metricsCollector: new MetricsCollector(),
    };

    logger.info(`[${i + 1}/${urls.length}] job=${jobId} email=${inbox.address} — starting`);
    const t0 = Date.now();
    try {
      // Per-job wall-clock watchdog: the browser bootstrap can hang indefinitely
      // (a Stagehand act / page op with no internal timeout, or a wedged
      // Browserbase session) — without this one stuck job freezes the whole
      // sequential batch. A normal job is ~50s; 5 min is a generous ceiling.
      const result = await Promise.race([
        hcaPlugin.executeHttp!(payload, context),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error(`job_timeout — exceeded ${JOB_TIMEOUT_MS / 1000}s wall-clock`)),
            JOB_TIMEOUT_MS
          )
        ),
      ]);
      const durationMs = Date.now() - t0;
      const data = result.data as {
        submitted?: boolean;
        progressPercentage?: number;
        formCompleteUrl?: string | null;
      };
      const submitted = data?.submitted === true;
      logger.info(
        `[${i + 1}/${urls.length}] job=${jobId} ${submitted ? "SUBMITTED" : "NO-SUBMIT"} ` +
          `progress=${data?.progressPercentage ?? "?"}% dur=${(durationMs / 1000).toFixed(1)}s`
      );
      verdicts.push({
        jobId,
        jobUrl: url,
        inboxAddress: inbox.address,
        submitStatus: submitted ? "PASS" : "FAIL",
        submitDurationMs: durationMs,
        emailReceived: false,
        progressPercentage: data?.progressPercentage ?? null,
        formCompleteUrl: data?.formCompleteUrl ?? null,
        ...(submitted ? {} : { error: `no-submit (progress ${data?.progressPercentage ?? "?"}%)` }),
      });
    } catch (err) {
      const durationMs = Date.now() - t0;
      const msg = toErrorMessage(err);
      logger.error(`[${i + 1}/${urls.length}] job=${jobId} FAILED: ${msg}`);
      verdicts.push({
        jobId,
        jobUrl: url,
        inboxAddress: inbox.address,
        submitStatus: "FAIL",
        submitDurationMs: durationMs,
        emailReceived: false,
        progressPercentage: null,
        formCompleteUrl: null,
        error: msg.slice(0, 200),
      });
    }
  }

  writeFileSync(reportPath, JSON.stringify(verdicts, null, 2));
  const passed = verdicts.filter((v) => v.submitStatus === "PASS").length;
  process.stdout.write(renderBatchReport(verdicts, { jobIdLabel: "jobId" }));
  process.stdout.write(
    `\nHCA hot-path batch: ${passed}/${verdicts.length} submitted. Report: ${reportPath}\n`
  );
}

void main().catch((err) => {
  logger.error(`hca-batch-test crashed: ${toErrorMessage(err)}`);
  process.exit(1);
});
