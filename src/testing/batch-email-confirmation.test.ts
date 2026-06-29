import { describe, expect, it, vi } from "vitest";

import type { PollOutcome, SubmitOutcome } from "@/testing/batch-email-confirmation";
import { runBatchEmailConfirmation } from "@/testing/batch-email-confirmation";
import type { TestmailInbox, TestmailMessage } from "@/testmail/client";

const FAKE_INBOX: TestmailInbox = {
  address: "ns.tag@inbox.testmail.app",
  tag: "tag",
  timestampFrom: 0,
};

const FAKE_MSG: TestmailMessage = {
  id: "msg-1",
  from: "noreply@example.com",
  subject: "Application Received",
  text: null,
  html: null,
  date: 0,
};

interface SimpleJob {
  id: string;
}

interface SimpleVerdict {
  id: string;
  submitOk: boolean;
  emailReceived: boolean;
}

function makeOpts(
  submitFn: (job: SimpleJob, inbox: TestmailInbox) => Promise<SubmitOutcome>,
  pollFn: (inbox: TestmailInbox) => Promise<PollOutcome>
) {
  return {
    allocateInbox: (_job: SimpleJob) => FAKE_INBOX,
    submit: submitFn,
    pollEmail: pollFn,
    mapVerdict: (
      job: SimpleJob,
      submitOutcome: SubmitOutcome,
      pollOutcome: PollOutcome | null
    ): SimpleVerdict => ({
      id: job.id,
      submitOk: submitOutcome.ok,
      emailReceived: pollOutcome?.received ?? false,
    }),
  };
}

describe("runBatchEmailConfirmation", () => {
  it("marks all jobs PASS and EMAIL when submit succeeds and email arrives", async () => {
    const jobs: SimpleJob[] = [{ id: "a" }, { id: "b" }];
    const opts = makeOpts(
      async (_job, inbox) => ({ ok: true as const, inbox, durationMs: 10 }),
      async (_inbox) => ({ received: true as const, message: FAKE_MSG, waitMs: 5 })
    );
    const verdicts = await runBatchEmailConfirmation(jobs, opts);
    expect(verdicts).toHaveLength(2);
    expect(verdicts.every((v) => v.submitOk)).toBe(true);
    expect(verdicts.every((v) => v.emailReceived)).toBe(true);
  });

  it("marks jobs FAIL and no EMAIL when submit fails", async () => {
    const jobs: SimpleJob[] = [{ id: "x" }];
    const opts = makeOpts(
      async (_job, _inbox) => ({ ok: false as const, error: "boom", durationMs: 0 }),
      async (_inbox) => ({ received: true as const, message: FAKE_MSG, waitMs: 5 })
    );
    const verdicts = await runBatchEmailConfirmation(jobs, opts);
    expect(verdicts[0]?.submitOk).toBe(false);
    expect(verdicts[0]?.emailReceived).toBe(false);
  });

  it("does not call pollEmail for failed jobs", async () => {
    const jobs: SimpleJob[] = [{ id: "y" }];
    const pollFn = vi
      .fn<(inbox: TestmailInbox) => Promise<PollOutcome>>()
      .mockResolvedValue({ received: true, message: FAKE_MSG, waitMs: 5 });
    const opts = {
      ...makeOpts(
        async (_job, _inbox) => ({ ok: false as const, error: "fail", durationMs: 0 }),
        pollFn
      ),
      pollEmail: pollFn,
    };
    await runBatchEmailConfirmation(jobs, opts);
    expect(pollFn).not.toHaveBeenCalled();
  });

  it("marks submitOk=true, emailReceived=false when email does not arrive", async () => {
    const jobs: SimpleJob[] = [{ id: "z" }];
    const opts = makeOpts(
      async (_job, inbox) => ({ ok: true as const, inbox, durationMs: 10 }),
      async (_inbox) => ({ received: false as const, waitMs: 100 })
    );
    const verdicts = await runBatchEmailConfirmation(jobs, opts);
    expect(verdicts[0]?.submitOk).toBe(true);
    expect(verdicts[0]?.emailReceived).toBe(false);
  });

  it("handles a mix of passing and failing jobs correctly", async () => {
    const jobs: SimpleJob[] = [{ id: "pass" }, { id: "fail" }, { id: "pass2" }];
    const opts = makeOpts(
      async (job, inbox) => {
        if (job.id === "fail") return { ok: false as const, error: "err", durationMs: 0 };
        return { ok: true as const, inbox, durationMs: 10 };
      },
      async (_inbox) => ({ received: true as const, message: FAKE_MSG, waitMs: 5 })
    );
    const verdicts = await runBatchEmailConfirmation(jobs, opts);
    expect(verdicts).toHaveLength(3);
    const byId = Object.fromEntries(verdicts.map((v) => [v.id, v]));
    expect(byId.pass?.submitOk).toBe(true);
    expect(byId.pass?.emailReceived).toBe(true);
    expect(byId.fail?.submitOk).toBe(false);
    expect(byId.fail?.emailReceived).toBe(false);
    expect(byId.pass2?.submitOk).toBe(true);
    expect(byId.pass2?.emailReceived).toBe(true);
  });

  it("uses concurrency option for phase-1 parallel submits", async () => {
    const jobs: SimpleJob[] = Array.from({ length: 4 }, (_, i) => ({ id: `j${i}` }));
    let concurrent = 0;
    let maxConcurrent = 0;
    const opts = {
      ...makeOpts(
        async (_job, inbox) => {
          concurrent++;
          maxConcurrent = Math.max(maxConcurrent, concurrent);
          await new Promise<void>((r) => setTimeout(r, 10));
          concurrent--;
          return { ok: true as const, inbox, durationMs: 10 };
        },
        async (_inbox) => ({ received: false as const, waitMs: 0 })
      ),
      concurrency: 2,
    };
    await runBatchEmailConfirmation(jobs, opts);
    expect(maxConcurrent).toBeLessThanOrEqual(2);
  });
});
