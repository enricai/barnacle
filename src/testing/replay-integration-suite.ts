/**
 * Eliminates the repeated describe.skipIf / it.each / runIntegrationJob /
 * message.subject assertion that every replay-based integration test duplicates.
 * Callers supply only the site-specific plugin, job list, and payload builder;
 * the generic scaffold (file load, INTEGRATION gate, fan-out, default assertion)
 * lives here once.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import type { SitePlugin } from "@/site-plugin";
import { runIntegrationJob } from "@/testing/integration-runner";
import type { PollTestmailInboxOptions, TestmailInbox, TestmailMessage } from "@/testmail/client";

const DEFAULT_TIMEOUT_MS = 600_000;

/** Job source: either a pre-loaded array or a path resolved relative to the caller's directory. */
type JobsSource<TJob> = { jobs: TJob[] } | { jobsPath: string; dirname: string };

/**
 * Options for `defineReplayIntegrationSuite`. The `plugin` type parameter may
 * be narrower than `SitePlugin<unknown, unknown>` — the helper casts internally.
 */
export interface ReplayIntegrationSuiteOptions<TJob> {
  /** Human-readable suite name, passed to `describe`. */
  suiteName: string;
  /** The plugin under test. Internally cast to `SitePlugin<unknown, unknown>`. */
  plugin: SitePlugin<unknown, unknown>;
  /**
   * Override `pollTestmailInbox` so unit tests avoid real network calls.
   * Mirrors the same escape-hatch on `IntegrationJobOptions`.
   */
  pollFn?: (opts: PollTestmailInboxOptions) => Promise<TestmailMessage>;
  /**
   * Called with the freshly allocated testmail inbox; must return the
   * site-specific dispatch payload with the inbox address embedded.
   */
  buildPayload: (job: TJob, inbox: TestmailInbox) => unknown;
  /**
   * Override the per-message assertion. Defaults to
   * `expect(message.subject).toBeTruthy()` — byte-identical to both existing
   * integration tests.
   */
  assertMessage?: (message: TestmailMessage, job: TJob) => void;
}

/**
 * Defines a replay-driven integration suite. Pass a `jobs` array or a
 * `jobsPath`+`dirname` pair — the file is read and JSON-parsed at suite
 * definition time. The suite is skipped unless `INTEGRATION=true`.
 */
export function defineReplayIntegrationSuite<TJob extends object>(
  source: JobsSource<TJob>,
  opts: ReplayIntegrationSuiteOptions<TJob>
): void {
  const { suiteName, plugin, buildPayload, assertMessage, pollFn } = opts;

  const jobs: TJob[] =
    "jobs" in source
      ? source.jobs
      : (JSON.parse(readFileSync(resolve(source.dirname, source.jobsPath), "utf8")) as TJob[]);

  describe.skipIf(process.env.INTEGRATION !== "true")(suiteName, () => {
    it.each(jobs)(`submits job and receives confirmation email`, {
      timeout: DEFAULT_TIMEOUT_MS,
    }, async (job) => {
      const { message } = await runIntegrationJob({
        plugin: plugin as unknown as SitePlugin<unknown, unknown>,
        baseUrl: (job as Record<string, unknown>).baseUrl as string,
        buildPayload: (inbox) => buildPayload(job, inbox),
        ...(pollFn ? { pollFn } : {}),
      });

      if (assertMessage) {
        assertMessage(message, job);
      } else {
        expect(message.subject).toBeTruthy();
      }
    });
  });
}
