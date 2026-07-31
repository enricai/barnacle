/**
 * Unit tests for the site-agnostic integration-test scaffold. Uses a stub
 * plugin + a fake pollFn so no network or browser session is needed.
 */

import { describe, expect, it, vi } from "vitest";

import type { SitePlugin, SitePluginContext, SitePluginResult } from "@/site-plugin";
import { runIntegrationJob } from "@/testing/integration-runner";
import type { TestmailInbox, TestmailMessage } from "@/testmail/client";

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

describe("runIntegrationJob", () => {
  it("allocates an inbox and passes it to buildPayload", async () => {
    const capturedInbox: TestmailInbox[] = [];
    const plugin = makeStubPlugin();

    await runIntegrationJob({
      plugin,
      baseUrl: "https://example.com",
      buildPayload: (inbox) => {
        capturedInbox.push(inbox);
        return { Email: inbox.address };
      },
      inboxOptions: { namespace: "test-ns" },
      pollFn: async () => STUB_MESSAGE,
    });

    expect(capturedInbox).toHaveLength(1);
    const firstInbox = capturedInbox[0] as TestmailInbox;
    expect(firstInbox.address).toContain("test-ns.");
    expect(firstInbox.tag).toMatch(/^barnacle-/);
  });

  it("invokes dispatch exactly once with the payload returned by buildPayload", async () => {
    let capturedPayload: unknown;
    const plugin = makeStubPlugin((payload) => {
      capturedPayload = payload;
    });

    await runIntegrationJob({
      plugin,
      baseUrl: "https://example.com",
      buildPayload: (inbox) => ({ Email: inbox.address, JobId: "42" }),
      inboxOptions: { namespace: "test-ns" },
      pollFn: async () => STUB_MESSAGE,
    });

    expect(plugin.executeHttp).toHaveBeenCalledTimes(1);
    const payload = capturedPayload as Record<string, string>;
    expect(payload.JobId).toBe("42");
    expect(payload.Email).toContain("test-ns.");
  });

  it("surfaces the poll result in the return value", async () => {
    const plugin = makeStubPlugin();

    const { result, message } = await runIntegrationJob({
      plugin,
      baseUrl: "https://example.com",
      buildPayload: (inbox) => ({ Email: inbox.address }),
      inboxOptions: { namespace: "test-ns" },
      pollFn: async () => STUB_MESSAGE,
    });

    expect(message.subject).toBeTruthy();
    expect(message).toBe(STUB_MESSAGE);
    expect((result.data as { ok: boolean }).ok).toBe(true);
  });

  it("passes pollTimeoutMs and subjectContains through to pollFn", async () => {
    const plugin = makeStubPlugin();
    const pollFn = vi.fn(async () => STUB_MESSAGE);

    await runIntegrationJob({
      plugin,
      baseUrl: "https://example.com",
      buildPayload: (inbox) => ({ Email: inbox.address }),
      inboxOptions: { namespace: "test-ns" },
      pollTimeoutMs: 30_000,
      pollSubjectContains: "received",
      pollFn,
    });

    expect(pollFn).toHaveBeenCalledOnce();
    expect(pollFn).toHaveBeenCalledWith(
      expect.objectContaining({ timeoutMs: 30_000, subjectContains: "received" })
    );
  });

  it("builds the context with requestId=integration-test and the supplied baseUrl", async () => {
    let capturedCtx: SitePluginContext | undefined;
    const plugin = makeStubPlugin((_, ctx) => {
      capturedCtx = ctx;
    });

    await runIntegrationJob({
      plugin,
      baseUrl: "https://my-site.example.com",
      buildPayload: (inbox) => ({ Email: inbox.address }),
      inboxOptions: { namespace: "test-ns" },
      pollFn: async () => STUB_MESSAGE,
    });

    expect(capturedCtx?.requestId).toBe("integration-test");
    expect(capturedCtx?.baseUrl).toBe("https://my-site.example.com");
    expect(capturedCtx?.metricsCollector).toBeDefined();
  });
});
