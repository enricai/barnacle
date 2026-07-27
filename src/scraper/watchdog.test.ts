import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { WatchdogTimeoutError, withWatchdog } from "@/scraper/watchdog";

describe("withWatchdog", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves with the operation's value when it settles in time", async () => {
    const promise = withWatchdog(() => Promise.resolve("ok"), {
      timeoutMs: 1_000,
      label: "test-op",
    });
    await vi.advanceTimersByTimeAsync(0);
    await expect(promise).resolves.toBe("ok");
  });

  it("rejects with the operation's original error unchanged when it rejects in time", async () => {
    const original = new Error("original failure");
    const promise = withWatchdog(() => Promise.reject(original), {
      timeoutMs: 1_000,
      label: "test-op",
    });
    await vi.advanceTimersByTimeAsync(0);
    await expect(promise).rejects.toBe(original);
  });

  it("rejects with a WatchdogTimeoutError naming label and timeoutMs when the operation never settles", async () => {
    const promise = withWatchdog(() => new Promise<string>(() => {}), {
      timeoutMs: 5_000,
      label: "hung-op",
    });
    const assertion = expect(promise).rejects.toMatchObject({
      name: "WatchdogTimeoutError",
      label: "hung-op",
      timeoutMs: 5_000,
    });
    await vi.advanceTimersByTimeAsync(5_000);
    await assertion;
  });

  it("rejects with a WatchdogTimeoutError instance", async () => {
    const promise = withWatchdog(() => new Promise<string>(() => {}), {
      timeoutMs: 5_000,
      label: "hung-op",
    });
    const assertion = expect(promise).rejects.toBeInstanceOf(WatchdogTimeoutError);
    await vi.advanceTimersByTimeAsync(5_000);
    await assertion;
  });

  it("leaves no pending timer after a fast resolution", async () => {
    const promise = withWatchdog(() => Promise.resolve("ok"), {
      timeoutMs: 1_000,
      label: "test-op",
    });
    await vi.advanceTimersByTimeAsync(0);
    await promise;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("leaves no pending timer after a fast rejection", async () => {
    const promise = withWatchdog(() => Promise.reject(new Error("boom")), {
      timeoutMs: 1_000,
      label: "test-op",
    });
    await vi.advanceTimersByTimeAsync(0);
    await promise.catch(() => {});
    expect(vi.getTimerCount()).toBe(0);
  });
});
