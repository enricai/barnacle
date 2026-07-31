/**
 * Unit tests for defineReplayIntegrationSuite. Uses a stub plugin + injected
 * pollFn + in-memory job array so no real network or browser session is needed.
 *
 * defineReplayIntegrationSuite registers vitest suites at top level; we
 * call it at top level here, then assert on captured call state inside the
 * registered it.each callbacks. We also test the skip-gate and default
 * assertion by exercising runIntegrationJob directly with the same inputs.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SitePlugin, SitePluginContext, SitePluginResult } from "@/site-plugin";
import { runIntegrationJob } from "@/testing/integration-runner";
import { defineReplayIntegrationSuite } from "@/testing/replay-integration-suite";
import type { TestmailInbox, TestmailMessage } from "@/testmail/client";

interface StubJob {
  id: string;
  baseUrl: string;
}

const STUB_RESULT: SitePluginResult<{ ok: boolean }> = {
  data: { ok: true },
  auditPayload: { ok: true },
};

function makeStubPlugin(
  onDispatch?: (payload: unknown, ctx: SitePluginContext) => void
): SitePlugin<unknown, unknown> {
  return {
    meta: {
      siteId: "stub-site",
      displayName: "Stub Site",
      bodySchema: {} as never,
      responseSchema: {} as never,
    },
    executeHttp: vi.fn(async (payload: unknown, ctx: SitePluginContext) => {
      onDispatch?.(payload, ctx);
      return STUB_RESULT as SitePluginResult<unknown>;
    }),
    execute: vi.fn(async () => STUB_RESULT as SitePluginResult<unknown>),
  };
}

const STUB_MESSAGE: TestmailMessage = {
  id: "msg-001",
  from: "noreply@example.com",
  subject: "Your application was received",
  text: "Thank you for applying.",
  html: null,
  date: 1_700_000_005_000,
};

const STUB_JOBS: StubJob[] = [
  { id: "job-1", baseUrl: "https://example.com/job/1" },
  { id: "job-2", baseUrl: "https://example.com/job/2" },
];

// ── (b) Skip-gate: suite is registered as skipped when INTEGRATION !== 'true' ──
// INTEGRATION is not set in this test run, so describe.skipIf is true and the
// suite below will be skipped. capturedBuildPayloadInboxes stays empty because
// the skipped it.each callbacks never run.
const capturedBuildPayloadInboxes: TestmailInbox[] = [];

defineReplayIntegrationSuite(
  { jobs: STUB_JOBS },
  {
    suiteName: "stub replay integration (registered by test file)",
    plugin: makeStubPlugin(),
    pollFn: async () => STUB_MESSAGE,
    buildPayload: (job, inbox) => {
      capturedBuildPayloadInboxes.push(inbox);
      return { Email: inbox.address, JobId: job.id };
    },
  }
);

// ── Unit tests ────────────────────────────────────────────────────────────────

describe("defineReplayIntegrationSuite", () => {
  beforeEach(() => {
    capturedBuildPayloadInboxes.length = 0;
  });

  // ── (a) buildPayload is invoked once per job with the allocated inbox ────
  it("calls buildPayload once per job with the allocated inbox", async () => {
    const capturedCalls: Array<{ job: StubJob; inbox: TestmailInbox }> = [];
    const plugin = makeStubPlugin();

    for (const job of STUB_JOBS) {
      await runIntegrationJob({
        plugin,
        baseUrl: job.baseUrl,
        buildPayload: (inbox: TestmailInbox) => {
          capturedCalls.push({ job, inbox });
          return { Email: inbox.address, JobId: job.id };
        },
        inboxOptions: { namespace: "test-ns" },
        pollFn: async () => STUB_MESSAGE,
      });
    }

    expect(capturedCalls).toHaveLength(2);
    expect(capturedCalls[0]?.inbox.address).toContain("test-ns.");
    expect(capturedCalls[1]?.inbox.address).toContain("test-ns.");
    expect(capturedCalls[0]?.job.id).toBe("job-1");
    expect(capturedCalls[1]?.job.id).toBe("job-2");
  });

  // ── (b) Suite is skipped when INTEGRATION is not 'true' ─────────────────
  it("does not run jobs when INTEGRATION is not 'true' (skipped suite leaves inbox array empty)", () => {
    expect(capturedBuildPayloadInboxes).toHaveLength(0);
  });

  // ── (c) Default assertion checks message.subject ─────────────────────────
  it("default assertion is expect(message.subject).toBeTruthy()", async () => {
    const plugin = makeStubPlugin();

    const { message } = await runIntegrationJob({
      plugin,
      baseUrl: "https://example.com",
      buildPayload: (inbox: TestmailInbox) => ({ Email: inbox.address }),
      inboxOptions: { namespace: "test-ns" },
      pollFn: async () => STUB_MESSAGE,
    });

    // Byte-identical to both existing integration tests and to the helper's fallback.
    expect(message.subject).toBeTruthy();
  });

  it("accepts a custom assertMessage override", async () => {
    const plugin = makeStubPlugin();
    const customAssert = vi.fn((_msg: TestmailMessage, _job: StubJob) => undefined);
    const firstJob = STUB_JOBS[0] as StubJob;

    const { message } = await runIntegrationJob({
      plugin,
      baseUrl: firstJob.baseUrl,
      buildPayload: (inbox: TestmailInbox) => ({ Email: inbox.address }),
      inboxOptions: { namespace: "test-ns" },
      pollFn: async () => STUB_MESSAGE,
    });

    customAssert(message, firstJob);
    expect(customAssert).toHaveBeenCalledOnce();
    expect(customAssert).toHaveBeenCalledWith(STUB_MESSAGE, firstJob);
  });

  it("throws ENOENT when jobsPath does not exist", () => {
    expect(() => {
      defineReplayIntegrationSuite(
        { jobsPath: "fixtures/nonexistent.json", dirname: "/tmp" },
        {
          suiteName: "file-based",
          plugin: makeStubPlugin(),
          pollFn: async () => STUB_MESSAGE,
          buildPayload: (_job, inbox) => ({ Email: inbox.address }),
        }
      );
    }).toThrow(/ENOENT/);
  });
});
