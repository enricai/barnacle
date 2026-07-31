import PQueue from "p-queue";

import { getLogger } from "@/lib/logging";
import type { TestmailInbox, TestmailMessage } from "@/testmail/client";

const logger = getLogger({ name: "testing/batch-email-confirmation" });

/**
 * Outcome of a single job's submit phase: either a successful submit (with
 * the allocated inbox) or a failed one (with an error message).
 */
export type SubmitOutcome =
  | { ok: true; inbox: TestmailInbox; durationMs: number }
  | { ok: false; error: string; durationMs: number };

/**
 * Outcome of a single job's email-poll phase. Only run for jobs that passed
 * phase 1.
 */
export type PollOutcome =
  | { received: true; message: TestmailMessage; waitMs: number }
  | { received: false; waitMs: number };

/**
 * Dependency-injected callbacks that make the harness site-agnostic. Callers
 * provide the site-specific logic; the harness owns the phase-1/phase-2 loop,
 * inbox allocation, and summary rendering.
 */
export interface BatchEmailConfirmationOptions<TJob, TVerdict> {
  /** Allocate a fresh testmail inbox for the job. Defaults to testmail client's `allocateTestmailInbox`. */
  allocateInbox: (job: TJob) => TestmailInbox;
  /** Submit the job with the given inbox address. Should throw on hard failure, or return a value. */
  submit: (job: TJob, inbox: TestmailInbox) => Promise<SubmitOutcome>;
  /**
   * Poll for a confirmation email in the inbox after a successful submit.
   * Defaults to 90 s. Should return PollOutcome whether email arrived or not.
   */
  pollEmail: (inbox: TestmailInbox) => Promise<PollOutcome>;
  /** Map the raw phase outcomes into the caller's verdict shape. */
  mapVerdict: (
    job: TJob,
    submitOutcome: SubmitOutcome,
    pollOutcome: PollOutcome | null
  ) => TVerdict;
  /** Max parallel phase-1 submits. Default 1 (serial). */
  concurrency?: number;
}

/**
 * Site-agnostic two-phase batch runner: submit each job with a fresh testmail
 * inbox (phase 1), then poll each successful inbox for a confirmation email
 * (phase 2). Returns one verdict per input job.
 *
 * Phase separation is intentional — all submits complete before any polling
 * begins, matching the expected cadence for ATS email confirmations that
 * arrive seconds after submission. The caller supplies all site-specific
 * behaviour via injected callbacks.
 */
export async function runBatchEmailConfirmation<TJob, TVerdict>(
  jobs: TJob[],
  opts: BatchEmailConfirmationOptions<TJob, TVerdict>
): Promise<TVerdict[]> {
  const { allocateInbox, submit, pollEmail, mapVerdict, concurrency = 1 } = opts;

  logger.info(`--- phase 1: submitting ${jobs.length} jobs (concurrency=${concurrency}) ---`);
  const queue = new PQueue({ concurrency });

  const phase1Results = await Promise.all(
    jobs.map((job, i) =>
      queue.add(async () => {
        const inbox = allocateInbox(job);
        const outcome = await submit(job, inbox).catch((err: unknown) => {
          const durationMs = 0;
          return {
            ok: false as const,
            error: err instanceof Error ? err.message : String(err),
            durationMs,
          };
        });
        const status = outcome.ok ? "PASS" : "FAIL";
        logger.info(`[${i + 1}/${jobs.length}] ${status} → ${inbox.address}`);
        return { job, inbox, outcome };
      })
    )
  );
  const phase1: Array<{ job: TJob; inbox: TestmailInbox; outcome: SubmitOutcome }> =
    phase1Results.filter((r): r is NonNullable<typeof r> => r != null);

  const passed = phase1.filter((r) => r.outcome.ok);
  const failCount = phase1.length - passed.length;
  logger.info(`phase 1 complete: ${passed.length}/${phase1.length} submitted, ${failCount} failed`);

  // serial to stay within testmail's per-account rate limit
  logger.info(`--- phase 2: polling ${passed.length} inboxes for confirmation emails ---`);
  const pollResults = new Map<TJob, PollOutcome>();
  for (const [i, r] of passed.entries()) {
    const pollOutcome = await pollEmail(r.inbox);
    pollResults.set(r.job, pollOutcome);
    if (pollOutcome.received) {
      logger.info(
        `[${i + 1}/${passed.length}] EMAIL: "${pollOutcome.message.subject}" from ${pollOutcome.message.from}`
      );
    } else {
      logger.info(`[${i + 1}/${passed.length}] NO EMAIL within timeout`);
    }
  }

  const emailCount = [...pollResults.values()].filter((p) => p.received).length;
  logger.info(
    `final: ${passed.length} submitted, ${failCount} failed, ${emailCount} confirmation emails received`
  );

  return phase1.map(({ job, outcome }) => {
    const pollOutcome = outcome.ok ? (pollResults.get(job) ?? null) : null;
    return mapVerdict(job, outcome, pollOutcome);
  });
}
