/**
 * Iterates a site's replay-jobs.json fixture and runs recon-browser once
 * per job, allocating a fresh testmail inbox per run so the confirmation-
 * email delivery is an independent end-to-end signal. Aggregates a
 * per-job verdict (integrated_apply 200 captured? terminal URL? email
 * received?) and prints a final report.
 *
 * Why a separate runner instead of vitest: each recon-browser run boots
 * a real browser, executes the LLM-driven cascade, and writes to
 * /tmp/recon/. Running them under vitest interleaves logs, blocks on
 * fork-pool limits, and obscures per-run telemetry. A direct sequential
 * driver gives cleaner per-job artifacts and a single aggregated report.
 *
 * Usage:
 *   pnpm tsx --env-file=.env src/scripts/recon-replay-jobs.ts \
 *     --jobs src/sites/appcast/fixtures/replay-jobs.json \
 *     --flow-file src/sites/appcast/recon-flow.json \
 *     --report /tmp/recon/replay-report.json
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { getScriptLogger } from "@/lib/logging";
import { detectRejectionInResponseBody } from "@/scripts/recon-browser";
import { resolveReconRunDir } from "@/scripts/recon-shared";
import { allocateTestmailInbox, pollTestmailInbox } from "@/testmail/client";

const logger = getScriptLogger("recon-replay-jobs");

interface ReplayJob {
  jobId: string;
  resolvedUrl: string;
}

interface JobVerdict {
  jobId: string;
  url: string;
  inboxAddress: string;
  reconExitCode: number | null;
  integratedApply200: boolean;
  /**
   * True when the submit endpoint returned a 2xx whose response body
   * declared rejection (e.g. AppCast `not_qualified: true`, Greenhouse
   * `rejected: true`). When this is true, `integratedApply200` should
   * NOT be interpreted as a real success — the application reached the
   * HTTP layer but was filtered out by the ATS's qualification check
   * before reaching the employer.
   */
  serverRejected: boolean;
  /**
   * The reason string the ATS reported when `serverRejected === true`,
   * verbatim from the response body (e.g. "Not qualified reason: email").
   * Null when the server accepted the submit or when the audit couldn't
   * find a matching capture.
   */
  serverRejectionReason: string | null;
  terminalUrl: string | null;
  emailReceived: boolean;
  emailSubject: string | null;
  capturesDir: string;
  durationMs: number;
}

function parseArgs(runDirRoot: string): { jobsPath: string; flowFile: string; reportPath: string } {
  const args = process.argv.slice(2);
  let jobsPath: string | null = null;
  let flowFile: string | null = null;
  let reportPath = join(runDirRoot, "replay-report.json");
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--jobs" && args[i + 1]) jobsPath = resolve(args[++i]!);
    else if (args[i] === "--flow-file" && args[i + 1]) flowFile = resolve(args[++i]!);
    else if (args[i] === "--report" && args[i + 1]) reportPath = resolve(args[++i]!);
  }
  if (!jobsPath || !flowFile) {
    logger.error(
      "usage: recon-replay-jobs.ts --jobs <jobs.json> --flow-file <flow.json> [--report <path>]"
    );
    process.exit(1);
  }
  return { jobsPath, flowFile, reportPath };
}

/**
 * Spawns recon-browser as a child process with RECON_EMAIL and RECON_RUN_ID
 * pre-bound in the child's env. The flow-file's `${RECON_EMAIL}` token
 * resolves to this address via the engine's existing substituteFlowEnvVars
 * step. Pinning RECON_RUN_ID forces the child's own resolveReconRunDir()
 * call to reuse the parent's run root instead of minting its own — without
 * this, the parent and child disagree on where captures land and the
 * before/after capture diff always sees an empty directory.
 */
export async function runReconForJob(
  url: string,
  flowFile: string,
  email: string,
  runId: string,
  graphqlDir: string
): Promise<{ exitCode: number | null; capturesBefore: Set<string>; billingError: boolean }> {
  mkdirSync(graphqlDir, { recursive: true });
  const capturesBefore = new Set(readdirSync(graphqlDir));

  // Flow-file ENOENT retry. If the flow file is transiently unreadable
  // (git stash mid-sweep, file system race), wait briefly and retry up
  // to 3 times before giving up. Covers the 2026-06-09 sweep where
  // recon-flow.json was missing for ~1 second between git operations,
  // causing job 7 to fail with ENOENT in 2 minutes rather than getting
  // a real verdict. Without this gate, transient file-system races
  // produce false negatives in the per-job verdict.
  const ENOENT_MAX_RETRIES = 3;
  const ENOENT_RETRY_DELAY_MS = 5000;
  for (let attempt = 0; attempt < ENOENT_MAX_RETRIES; attempt++) {
    if (existsSync(flowFile)) break;
    if (attempt === ENOENT_MAX_RETRIES - 1) {
      logger.error(
        `flow file '${flowFile}' missing after ${ENOENT_MAX_RETRIES} attempts (${
          (ENOENT_MAX_RETRIES - 1) * ENOENT_RETRY_DELAY_MS
        }ms total wait); spawning child anyway and letting it fail explicitly`
      );
      break;
    }
    logger.warn(
      `flow file '${flowFile}' missing (attempt ${attempt + 1}/${ENOENT_MAX_RETRIES}); retrying in ${ENOENT_RETRY_DELAY_MS}ms`
    );
    await sleep(ENOENT_RETRY_DELAY_MS);
  }

  // Pipe stdio so the parent can scan stdout/stderr for the
  // FATAL_BILLING marker the engine emits when Anthropic rejects a
  // call due to credit exhaustion — there's no point continuing a
  // multi-job sweep when every subsequent job will fail identically.
  let billingError = false;
  const exitCode = await new Promise<number | null>((resolveExit) => {
    const child = spawn(
      "pnpm",
      [
        "tsx",
        "src/scripts/recon-browser.ts",
        "--url",
        url,
        "--flow-file",
        flowFile,
        "--advanced-stealth",
      ],
      {
        stdio: ["inherit", "pipe", "pipe"],
        env: { ...process.env, RECON_EMAIL: email, RECON_RUN_ID: runId },
      }
    );
    const scan = (chunk: Buffer | string, sink: NodeJS.WriteStream): void => {
      sink.write(chunk);
      if (!billingError && /FATAL_BILLING/.test(chunk.toString())) {
        billingError = true;
      }
    };
    child.stdout?.on("data", (chunk) => scan(chunk, process.stdout));
    child.stderr?.on("data", (chunk) => scan(chunk, process.stderr));
    child.on("exit", (code) => resolveExit(code));
    child.on("error", (err) => {
      logger.error(`recon spawn failed: ${err.message}`);
      resolveExit(null);
    });
  });

  return { exitCode, capturesBefore, billingError };
}

/**
 * Scans the recon's graphql capture directory for files written during
 * this job's run, returning whether the AppCast integrated_apply
 * endpoint captured a 200 and the SPA's terminal URL.
 */
export function readJobOutcome(
  capturesBefore: Set<string>,
  graphqlDir: string
): {
  integratedApply200: boolean;
  serverRejected: boolean;
  serverRejectionReason: string | null;
  terminalUrl: string | null;
} {
  const after = readdirSync(graphqlDir);
  const newCaptures = after.filter((f) => !capturesBefore.has(f));

  let integratedApply200 = false;
  let serverRejected = false;
  let serverRejectionReason: string | null = null;
  let terminalUrl: string | null = null;
  for (const f of newCaptures) {
    try {
      const data = JSON.parse(readFileSync(resolve(graphqlDir, f), "utf8")) as {
        status?: number;
        url?: string;
        responseBody?: unknown;
      };
      if (
        typeof data.url === "string" &&
        /\/api\/jobs\/\d+\/(integrated_apply|apply)(\?|$)/.test(data.url) &&
        data.status === 200
      ) {
        integratedApply200 = true;
        // Parse the response body to detect server-side rejection envelopes
        // (AppCast `not_qualified`, Greenhouse `rejected`, Lever `qualified:
        // false`, Workday `status: "rejected"`). HTTP 200 alone is not proof
        // of acceptance — many ATSs use a "200 with rejection envelope"
        // pattern. The capture writer at recon-browser.ts:240 stores
        // responseBody as either an object (JSON success) or a string
        // (JSON-parse failure fallback) — handle both shapes here.
        let body: unknown = data.responseBody;
        if (typeof body === "string") {
          try {
            body = JSON.parse(body);
          } catch {
            body = null;
          }
        }
        const rejection = detectRejectionInResponseBody(body);
        if (rejection.rejected) {
          serverRejected = true;
          serverRejectionReason = rejection.reason;
        }
      }
      if (typeof data.url === "string" && /\/applyboard\/applied/.test(data.url)) {
        terminalUrl = data.url;
      }
    } catch {}
  }
  return { integratedApply200, serverRejected, serverRejectionReason, terminalUrl };
}

async function main(): Promise<void> {
  const runDir = resolveReconRunDir();
  const { jobsPath, flowFile, reportPath } = parseArgs(runDir.root);
  const jobs: ReplayJob[] = JSON.parse(readFileSync(jobsPath, "utf8"));
  logger.info(
    `replay: ${jobs.length} jobs from ${jobsPath}, flow=${flowFile}, runId=${runDir.runId}`
  );

  const verdicts: JobVerdict[] = [];
  for (let i = 0; i < jobs.length; i++) {
    const job = jobs[i]!;
    const inbox = allocateTestmailInbox();
    const start = Date.now();
    logger.info(`[${i + 1}/${jobs.length}] jobId=${job.jobId} inbox=${inbox.address}`);

    const { exitCode, capturesBefore, billingError } = await runReconForJob(
      job.resolvedUrl,
      flowFile,
      inbox.address,
      runDir.runId,
      runDir.graphqlDir
    );
    const { integratedApply200, serverRejected, serverRejectionReason, terminalUrl } =
      readJobOutcome(capturesBefore, runDir.graphqlDir);

    let emailReceived = false;
    let emailSubject: string | null = null;
    try {
      const message = await pollTestmailInbox({ inbox, timeoutMs: 120_000 });
      emailReceived = true;
      emailSubject = message.subject;
    } catch (err) {
      logger.warn(
        `[${i + 1}/${jobs.length}] inbox poll did not yield message: ${(err as Error).message}`
      );
    }

    const verdict: JobVerdict = {
      jobId: job.jobId,
      url: job.resolvedUrl,
      inboxAddress: inbox.address,
      reconExitCode: exitCode,
      integratedApply200,
      serverRejected,
      serverRejectionReason,
      terminalUrl,
      emailReceived,
      emailSubject,
      capturesDir: runDir.graphqlDir,
      durationMs: Date.now() - start,
    };
    verdicts.push(verdict);
    const rejectionSuffix = serverRejected
      ? ` REJECTED="${serverRejectionReason ?? "(no reason)"}"`
      : "";
    logger.info(
      `[${i + 1}/${jobs.length}] verdict: exit=${exitCode} apply200=${integratedApply200} accepted=${integratedApply200 && !serverRejected}${rejectionSuffix} email=${emailReceived} subj=${emailSubject ?? "-"} dur=${Math.round(verdict.durationMs / 1000)}s`
    );

    writeFileSync(reportPath, `${JSON.stringify(verdicts, null, 2)}\n`);

    if (billingError) {
      // Hard short-circuit: every subsequent job's LLM-cascade will fail
      // identically with the same billing error. Burning Browserbase
      // sessions on them is pure waste — surface the gap loud and exit.
      logger.error(
        `replay aborted: Anthropic API billing exhausted detected in job ${i + 1}/${jobs.length}; remaining ${jobs.length - i - 1} job(s) skipped. Top up at https://console.anthropic.com/billing then re-run.`
      );
      break;
    }
  }

  const httpAccepted = verdicts.filter((v) => v.integratedApply200 && !v.serverRejected).length;
  const httpAcceptedWithEmail = verdicts.filter(
    (v) => v.integratedApply200 && !v.serverRejected && v.emailReceived
  ).length;
  const httpRejected = verdicts.filter((v) => v.integratedApply200 && v.serverRejected).length;
  logger.info(
    `replay complete: ${httpAccepted}/${verdicts.length} accepted (HTTP 200 + no rejection envelope); ${httpRejected} rejected by ATS qualification filter; ${httpAcceptedWithEmail} also received confirmation email`
  );
  logger.info(`report: ${reportPath}`);
}

if (
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith("recon-replay-jobs.ts") ||
    process.argv[1].endsWith("recon-replay-jobs.js"))
) {
  main().catch((err) => {
    logger.error(`replay failed: ${(err as Error).stack ?? String(err)}`);
    process.exit(1);
  });
}
