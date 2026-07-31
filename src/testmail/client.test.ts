/**
 * Unit tests for the testmail.app client. Fully mocks `fetch` and pins the
 * `config.testmail.*` shape so the module imports stay self-contained — no
 * .env required to run these.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/config", () => ({
  config: {
    testmail: {
      apiKey: "test-api-key",
      namespace: "test-namespace",
    },
  },
}));

const { loggerStub } = vi.hoisted(() => ({
  loggerStub: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    errorWithStack: vi.fn(),
  },
}));
vi.mock("@/lib/logging", () => ({
  getLogger: () => loggerStub,
  getScriptLogger: () => loggerStub,
}));

import {
  allocateTestmailInbox,
  pollTestmailInbox,
  resetTestmailClientForTests,
} from "@/testmail/client";
import { TestmailTimeoutError } from "@/testmail/errors";

function mockFetchOnce(body: unknown, status = 200): void {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      status,
      ok: status >= 200 && status < 300,
      headers: { get: vi.fn().mockReturnValue(null) },
      text: vi.fn().mockResolvedValue(JSON.stringify(body)),
    })
  );
}

function mockFetchSequence(bodies: unknown[]): void {
  const fetchFn = vi.fn();
  for (const body of bodies) {
    fetchFn.mockResolvedValueOnce({
      status: 200,
      ok: true,
      headers: { get: vi.fn().mockReturnValue(null) },
      text: vi.fn().mockResolvedValue(JSON.stringify(body)),
    });
  }
  vi.stubGlobal("fetch", fetchFn);
}

describe("allocateTestmailInbox", () => {
  beforeEach(() => {
    resetTestmailClientForTests();
  });

  it("returns a tag in the form `barnacle-XXXXXXXX`", () => {
    const inbox = allocateTestmailInbox();
    expect(inbox.tag).toMatch(/^barnacle-[0-9a-f]{8}$/);
  });

  it("builds the address as `{namespace}.{tag}@inbox.testmail.app`", () => {
    const inbox = allocateTestmailInbox();
    expect(inbox.address).toBe(`test-namespace.${inbox.tag}@inbox.testmail.app`);
  });

  it("returns a fresh `timestampFrom` per call", () => {
    const a = allocateTestmailInbox();
    const b = allocateTestmailInbox();
    expect(b.timestampFrom).toBeGreaterThanOrEqual(a.timestampFrom);
  });

  it("respects the `namespace` opts override", () => {
    const inbox = allocateTestmailInbox({ namespace: "other-namespace" });
    expect(inbox.address).toMatch(/^other-namespace\./);
  });
});

describe("pollTestmailInbox", () => {
  beforeEach(() => {
    resetTestmailClientForTests();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns the first matching message when the inbox has emails", async () => {
    const inbox = allocateTestmailInbox();
    mockFetchOnce({
      data: {
        inbox: {
          result: "success",
          message: null,
          count: 1,
          emails: [
            {
              id: "msg-1",
              from: "noreply@example.com",
              subject: "Application Received",
              text: "Thanks!",
              html: null,
              date: 1780600000000,
            },
          ],
        },
      },
    });

    const msg = await pollTestmailInbox({
      inbox,
      subjectContains: "received",
      timeoutMs: 1_000,
      intervalMs: 10,
    });

    expect(msg.id).toBe("msg-1");
    expect(msg.subject).toBe("Application Received");
    expect(msg.from).toBe("noreply@example.com");
  });

  it("returns ANY message when `subjectContains` is omitted", async () => {
    const inbox = allocateTestmailInbox();
    mockFetchOnce({
      data: {
        inbox: {
          result: "success",
          message: null,
          count: 1,
          emails: [
            {
              id: "msg-7",
              from: "x@y.z",
              subject: "Anything goes",
              text: null,
              html: null,
              date: 1780600000000,
            },
          ],
        },
      },
    });

    const msg = await pollTestmailInbox({
      inbox,
      timeoutMs: 1_000,
      intervalMs: 10,
    });

    expect(msg.id).toBe("msg-7");
  });

  it("skips non-matching subjects and continues polling until match arrives", async () => {
    const inbox = allocateTestmailInbox();
    mockFetchSequence([
      {
        data: {
          inbox: {
            result: "success",
            message: null,
            count: 1,
            emails: [
              {
                id: "noise",
                from: "spam@example.com",
                subject: "Newsletter",
                text: null,
                html: null,
                date: 1780600000000,
              },
            ],
          },
        },
      },
      {
        data: {
          inbox: {
            result: "success",
            message: null,
            count: 2,
            emails: [
              {
                id: "noise",
                from: "spam@example.com",
                subject: "Newsletter",
                text: null,
                html: null,
                date: 1780600000000,
              },
              {
                id: "target",
                from: "noreply@example.com",
                subject: "Receipt Confirmed",
                text: null,
                html: null,
                date: 1780600060000,
              },
            ],
          },
        },
      },
    ]);

    const msg = await pollTestmailInbox({
      inbox,
      subjectContains: "receipt",
      timeoutMs: 5_000,
      intervalMs: 10,
    });

    expect(msg.id).toBe("target");
  });

  it("throws TestmailTimeoutError when no matching message arrives in the budget", async () => {
    const inbox = allocateTestmailInbox();
    // Always return empty inbox.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        status: 200,
        ok: true,
        headers: { get: vi.fn().mockReturnValue(null) },
        text: vi.fn().mockResolvedValue(
          JSON.stringify({
            data: {
              inbox: {
                result: "success",
                message: null,
                count: 0,
                emails: [],
              },
            },
          })
        ),
      })
    );

    await expect(
      pollTestmailInbox({
        inbox,
        subjectContains: "Receipt",
        timeoutMs: 50,
        intervalMs: 10,
      })
    ).rejects.toThrow(TestmailTimeoutError);
  });

  it("includes the configured subjectContains in the timeout message", async () => {
    const inbox = allocateTestmailInbox();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        status: 200,
        ok: true,
        headers: { get: vi.fn().mockReturnValue(null) },
        text: vi.fn().mockResolvedValue(
          JSON.stringify({
            data: {
              inbox: { result: "success", message: null, count: 0, emails: [] },
            },
          })
        ),
      })
    );

    await expect(
      pollTestmailInbox({
        inbox,
        subjectContains: "MySpecificSubject",
        timeoutMs: 30,
        intervalMs: 10,
      })
    ).rejects.toThrow(/MySpecificSubject/);
  });

  it("treats a non-success `result` field as a recoverable API error and retries", async () => {
    const inbox = allocateTestmailInbox();
    mockFetchSequence([
      {
        data: {
          inbox: {
            result: "fail",
            message: "transient",
            count: 0,
            emails: [],
          },
        },
      },
      {
        data: {
          inbox: {
            result: "success",
            message: null,
            count: 1,
            emails: [
              {
                id: "ok",
                from: "x@y.z",
                subject: "Hello",
                text: null,
                html: null,
                date: 1780600000000,
              },
            ],
          },
        },
      },
    ]);

    const msg = await pollTestmailInbox({
      inbox,
      timeoutMs: 5_000,
      intervalMs: 10,
    });

    expect(msg.id).toBe("ok");
  });
});
