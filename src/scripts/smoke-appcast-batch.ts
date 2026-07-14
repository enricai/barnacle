/**
 * Batch-runs the AppCast plugin HTTP route against every job in
 * `src/sites/appcast/fixtures/replay-jobs.json` that matches a regex
 * over the `employer` field. Each job gets a fresh testmail inbox, the
 * full multipart payload with `ClickUrl=<resolvedUrl>`, and a 5-minute
 * post-response email-confirmation wait.
 *
 * Why a separate runner instead of vitest's INTEGRATION test:
 *   - Vitest test files run serially per-fork by default; this script
 *     fans out via `p-queue` to exercise the scraper pool's real
 *     concurrency (config.scraper.poolSize) the way production would.
 *   - The verdict matrix (HTTP status, duration, email-received) is
 *     written to a stable JSON path + a markdown table to stdout, so
 *     the run is grep-able after the fact without parsing test output.
 *   - It hits the actual fastify route (with auth bypass), proving the
 *     production POST /v1/appcast/run path works end-to-end per tenant.
 *
 * Prerequisites:
 *   - Dev server running on http://localhost:3000 with
 *     DEV_BYPASS_AUTH=true (no Authorization header is sent).
 *   - .env populated with BROWSERBASE_*, ANTHROPIC_API_KEY, TESTMAIL_*.
 *
 * Usage:
 *   pnpm tsx --env-file=.env src/scripts/smoke-appcast-batch.ts \
 *     [--employers '<regex>'] \
 *     [--jobs <path>] \
 *     [--host http://localhost:3000] \
 *     [--report <path>] \
 *     [--email-timeout-ms 300000]
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { config } from "@/config";
import { getScriptLogger } from "@/lib/logging";
import { APPCAST_PAYLOAD_DEFAULTS } from "@/sites/appcast/fixtures/payload-defaults";
import type { SubmitOutcome } from "@/testing/batch-email-confirmation";
import { runBatchEmailConfirmation } from "@/testing/batch-email-confirmation";
import { type BatchJobVerdict, renderBatchReport } from "@/testing/batch-report";
import { TEST_PERSONA } from "@/testing/persona-fixture";
import { loadTestResume } from "@/testing/resume-fixture";
import { allocateTestmailInbox, pollTestmailInbox } from "@/testmail/client";

const logger = getScriptLogger("smoke-appcast-batch");

interface ReplayJob {
  jobId: string;
  baseUrl: string;
  resolvedUrl: string;
  employer: string;
  hospitalState: string;
  jobTitle: string;
  auditJobId: string;
  cs?: string;
  exch?: string;
  jg?: string;
}

/** Kept separate from BatchJobVerdict so the JSON artifact retains site-specific fields (employer, hospitalState, HTTP status) without widening the shared renderer's type. */
interface JobVerdict {
  auditJobId: string;
  employer: string;
  hospitalState: string;
  jobId: string;
  jobTitle: string;
  inboxAddress: string;
  httpStatus: number | null;
  httpDurationMs: number | null;
  responseBodyTruncated: string;
  emailReceived: boolean;
  emailSubject: string | null;
  emailWaitMs: number | null;
  errorMessage: string | null;
}

interface CliArgs {
  jobsPath: string;
  host: string;
  employersRegex: RegExp;
  reportPath: string;
  emailTimeoutMs: number;
}

/** Parses --flag value pairs into a typed args record with sensible defaults. */
function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  const get = (name: string): string | null => {
    const i = args.indexOf(name);
    return i >= 0 && args[i + 1] ? (args[i + 1] ?? null) : null;
  };
  return {
    jobsPath: resolve(get("--jobs") ?? "src/sites/appcast/fixtures/replay-jobs.json"),
    host: get("--host") ?? "http://localhost:3000",
    employersRegex: new RegExp(get("--employers") ?? "Encompass|Presbyterian", "i"),
    reportPath: get("--report") ?? `/tmp/appcast-batch-report-${Date.now()}.json`,
    emailTimeoutMs: Number(get("--email-timeout-ms") ?? 300_000),
  };
}

/**
 * Builds the multipart FormData body the plugin's route expects. Kept
 * as a pure factory so each parallel job constructs its own body with
 * its own per-job inbox + ClickUrl without sharing mutable state.
 */
function buildPayload(job: ReplayJob, inboxAddress: string): FormData {
  const resume = loadTestResume();
  const fd = new FormData();
  fd.append("JobId", job.jobId);
  fd.append("BaseUrl", job.baseUrl);
  fd.append("ClickUrl", job.resolvedUrl);
  if (job.cs) fd.append("Cs", job.cs);
  if (job.exch) fd.append("Exch", job.exch);
  if (job.jg) fd.append("Jg", job.jg);
  fd.append("FirstName", TEST_PERSONA.FirstName);
  fd.append("LastName", TEST_PERSONA.LastName);
  fd.append("Email", inboxAddress);
  fd.append("Phone", TEST_PERSONA.Phone);
  fd.append("AddressLine", TEST_PERSONA.Address.Line1);
  fd.append("City", TEST_PERSONA.Address.City);
  fd.append("State", TEST_PERSONA.Address.StateAbbreviation);
  fd.append("PostalCode", TEST_PERSONA.Address.PostalCode);
  fd.append("Country", TEST_PERSONA.Address.CountryName);
  fd.append("County", TEST_PERSONA.Address.County);
  fd.append(
    "Resume",
    new Blob([new Uint8Array(resume.buffer)], { type: resume.contentType }),
    resume.filename
  );
  fd.append("ResumeContentType", resume.contentType);
  fd.append("ResumeFilename", resume.filename);
  fd.append("ResumeBase64", resume.base64);
  fd.append("Answers", JSON.stringify(APPCAST_PAYLOAD_DEFAULTS.Answers));
  return fd;
}

/**
 * Folds site-specific fields into the shared BatchJobVerdict shape for
 * stdout rendering. Employer and state are appended to jobId so the
 * shared renderer's columns stay stable without coupling main to site fields.
 */
function toBatchVerdicts(verdicts: JobVerdict[]): BatchJobVerdict[] {
  return verdicts.map((v) => ({
    jobId: `${v.auditJobId.slice(0, 20)} [${v.employer.slice(0, 20)}, ${v.hospitalState}]`,
    submitStatus:
      v.httpStatus != null && v.httpStatus < 400 ? ("PASS" as const) : ("FAIL" as const),
    submitDurationMs: v.httpDurationMs,
    emailReceived: v.emailReceived,
    emailSubject: v.emailSubject ?? undefined,
    error: v.errorMessage ?? undefined,
  }));
}

// HTTP metadata the harness doesn't expose through SubmitOutcome; captured in a side-channel so mapVerdict can read it.
interface SubmitMeta {
  httpStatus: number | null;
  httpDurationMs: number | null;
  responseBodyTruncated: string;
}

const submitMeta = new Map<ReplayJob, SubmitMeta>();

async function main(): Promise<void> {
  const args = parseArgs();
  const allJobs: ReplayJob[] = JSON.parse(readFileSync(args.jobsPath, "utf8"));
  const jobs = allJobs.filter((j) => args.employersRegex.test(j.employer));
  logger.info(
    `${jobs.length}/${allJobs.length} jobs match /${args.employersRegex.source}/ — running with concurrency=${config.scraper.poolSize}`
  );
  if (jobs.length === 0) {
    logger.error("no jobs matched the employer filter; aborting");
    process.exit(1);
  }

  const verdicts = await runBatchEmailConfirmation<ReplayJob, JobVerdict>(jobs, {
    allocateInbox: () => allocateTestmailInbox(),
    submit: async (job, inbox): Promise<SubmitOutcome> => {
      logger.info(`[${job.auditJobId}] posting (${job.employer} — ${job.jobTitle})`);
      const t0 = Date.now();
      const fd = buildPayload(job, inbox.address);
      try {
        const res = await fetch(`${args.host}/v1/appcast/run`, { method: "POST", body: fd });
        const body = await res.text();
        const httpDurationMs = Date.now() - t0;
        logger.info(
          `[${job.auditJobId}] HTTP ${res.status} dur=${(httpDurationMs / 1000).toFixed(1)}s`
        );
        submitMeta.set(job, {
          httpStatus: res.status,
          httpDurationMs,
          responseBodyTruncated: body.slice(0, 500),
        });
        return { ok: true, inbox, durationMs: httpDurationMs };
      } catch (err) {
        const durationMs = Date.now() - t0;
        submitMeta.set(job, {
          httpStatus: null,
          httpDurationMs: durationMs,
          responseBodyTruncated: "",
        });
        return {
          ok: false,
          error: `http: ${err instanceof Error ? err.message : String(err)}`,
          durationMs,
        };
      }
    },
    pollEmail: async (inbox) => {
      const t0 = Date.now();
      try {
        const msg = await pollTestmailInbox({ inbox, timeoutMs: args.emailTimeoutMs });
        return { received: true, message: msg, waitMs: Date.now() - t0 };
      } catch {
        return {
          received: false,
          waitMs: Date.now() - t0,
        };
      }
    },
    mapVerdict: (job, submitOutcome, pollOutcome) => {
      const meta = submitMeta.get(job);
      const emailReceived = pollOutcome?.received ?? false;
      const emailSubject = pollOutcome?.received ? pollOutcome.message.subject : null;
      const emailWaitMs = pollOutcome?.waitMs ?? null;
      const errorMessage = submitOutcome.ok
        ? pollOutcome && !pollOutcome.received
          ? `email: timed out after ${args.emailTimeoutMs}ms`
          : null
        : submitOutcome.error;
      return {
        auditJobId: job.auditJobId,
        employer: job.employer,
        hospitalState: job.hospitalState,
        jobId: job.jobId,
        jobTitle: job.jobTitle,
        inboxAddress: submitOutcome.ok ? submitOutcome.inbox.address : "",
        httpStatus: meta?.httpStatus ?? null,
        httpDurationMs: meta?.httpDurationMs ?? null,
        responseBodyTruncated: meta?.responseBodyTruncated ?? "",
        emailReceived,
        emailSubject,
        emailWaitMs,
        errorMessage,
      };
    },
    concurrency: config.scraper.poolSize,
  });

  writeFileSync(args.reportPath, JSON.stringify(verdicts, null, 2));
  logger.info(`report written to ${args.reportPath}`);
  // process.stdout.write preserves markdown formatting; pino would JSON-stringify it
  process.stdout.write(
    renderBatchReport(toBatchVerdicts(verdicts), { jobIdLabel: "auditJobId [employer, state]" })
  );
}

main().catch((err: unknown) => {
  logger.error(`fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
