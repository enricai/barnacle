import { describe, expect, it, vi } from "vitest";

import type { BrowserSession } from "@/scraper/session-shared";
import { withBrowserSession } from "@/scraper/session-warmup";

const { loggerStub } = vi.hoisted(() => ({
  loggerStub: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));
vi.mock("@/lib/logging", () => ({ getLogger: () => loggerStub }));

function makeSession(overrides?: Partial<BrowserSession>): BrowserSession {
  return {
    stagehand: {} as BrowserSession["stagehand"],
    limiter: {} as BrowserSession["limiter"],
    sessionId: "test-session-id",
    provider: "browserbase",
    close: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

const noopExhaustionMap = (err: unknown): Error =>
  new Error(`exhausted: ${err instanceof Error ? err.message : String(err)}`);

describe("withBrowserSession", () => {
  it("calls the callback with the session and returns its value on first success", async () => {
    const session = makeSession();
    const factory = vi.fn().mockResolvedValue(session);
    const callback = vi.fn().mockResolvedValue("token-data");

    const result = await withBrowserSession(factory, callback, {
      retryOptions: { retries: 2 },
      mapExhaustionError: noopExhaustionMap,
    });

    expect(result).toBe("token-data");
    expect(factory).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith(session, 1);
  });

  it("always calls session.close() on success", async () => {
    const session = makeSession();
    const factory = vi.fn().mockResolvedValue(session);
    const callback = vi.fn().mockResolvedValue("ok");

    await withBrowserSession(factory, callback, {
      retryOptions: { retries: 0 },
      mapExhaustionError: noopExhaustionMap,
    });

    expect(session.close).toHaveBeenCalledTimes(1);
  });

  it("always calls session.close() when the callback throws", async () => {
    const session = makeSession();
    const factory = vi.fn().mockResolvedValue(session);
    const callback = vi.fn().mockRejectedValue(new Error("callback boom"));

    await expect(
      withBrowserSession(factory, callback, {
        retryOptions: { retries: 0 },
        mapExhaustionError: noopExhaustionMap,
      })
    ).rejects.toThrow();

    expect(session.close).toHaveBeenCalledTimes(1);
  });

  it("retries up to the configured attempt count and closes the session each attempt", async () => {
    const sessions = [
      makeSession({ sessionId: "s1" }),
      makeSession({ sessionId: "s2" }),
      makeSession({ sessionId: "s3" }),
    ];
    let callCount = 0;
    const factory = vi.fn().mockImplementation(async () => sessions[callCount++]);
    const callback = vi.fn().mockRejectedValue(new Error("transient failure"));

    await expect(
      withBrowserSession(factory, callback, {
        retryOptions: { retries: 2, minTimeout: 0 },
        mapExhaustionError: noopExhaustionMap,
      })
    ).rejects.toThrow("exhausted");

    // 3 total attempts = 1 initial + 2 retries
    expect(factory).toHaveBeenCalledTimes(3);
    expect(callback).toHaveBeenCalledTimes(3);
    for (const session of sessions) {
      expect(session.close).toHaveBeenCalledTimes(1);
    }
  });

  it("throws the caller-supplied error type when all attempts fail", async () => {
    const session = makeSession();
    const factory = vi.fn().mockResolvedValue(session);
    const callback = vi.fn().mockRejectedValue(new Error("boom"));

    class DomainError extends Error {}
    const mapExhaustionError = (): DomainError => new DomainError("domain exhausted");

    await expect(
      withBrowserSession(factory, callback, {
        retryOptions: { retries: 1, minTimeout: 0 },
        mapExhaustionError,
      })
    ).rejects.toBeInstanceOf(DomainError);
  });

  it("succeeds on a retry after initial failures", async () => {
    const sessions = [makeSession({ sessionId: "s1" }), makeSession({ sessionId: "s2" })];
    let callCount = 0;
    const factory = vi.fn().mockImplementation(async () => sessions[callCount++]);
    const callback = vi
      .fn()
      .mockRejectedValueOnce(new Error("transient"))
      .mockResolvedValueOnce("recovered");

    const result = await withBrowserSession(factory, callback, {
      retryOptions: { retries: 2, minTimeout: 0 },
      mapExhaustionError: noopExhaustionMap,
    });

    expect(result).toBe("recovered");
    expect(factory).toHaveBeenCalledTimes(2);
    for (const session of sessions) {
      expect(session.close).toHaveBeenCalledTimes(1);
    }
  });

  it("still closes session and warns when close() itself throws", async () => {
    const session = makeSession({
      close: vi.fn().mockRejectedValue(new Error("close failed")),
    });
    const factory = vi.fn().mockResolvedValue(session);
    const callback = vi.fn().mockResolvedValue("ok");

    loggerStub.warn.mockClear();
    const result = await withBrowserSession(factory, callback, {
      retryOptions: { retries: 0 },
      mapExhaustionError: noopExhaustionMap,
    });

    expect(result).toBe("ok");
    expect(loggerStub.warn).toHaveBeenCalledOnce();
    const msg = loggerStub.warn.mock.calls[0]?.[0] as string;
    expect(msg).toMatch(/close failed/);
  });
});
