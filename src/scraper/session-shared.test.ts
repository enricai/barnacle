import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createTimeoutFetch } from "@/scraper/session-shared";

describe("createTimeoutFetch", () => {
  let fetchStub: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    fetchStub = vi.fn(
      (..._args: Parameters<typeof fetch>) =>
        new Promise<Response>((_resolve, reject) => {
          const init = _args[1];
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        })
    );
    vi.stubGlobal("fetch", fetchStub);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("aborts the request's signal after timeoutMs elapses", async () => {
    const timeoutFetch = createTimeoutFetch(1000);
    const result = timeoutFetch("https://example.com");
    result.catch(() => undefined);

    const passedSignal = fetchStub.mock.calls[0]?.[1]?.signal as AbortSignal;
    expect(passedSignal.aborted).toBe(false);

    vi.advanceTimersByTime(1000);

    await expect(result).rejects.toBeDefined();
    expect(passedSignal.aborted).toBe(true);
  });

  it("does not abort before timeoutMs elapses", () => {
    const timeoutFetch = createTimeoutFetch(1000);
    timeoutFetch("https://example.com").catch(() => undefined);

    const passedSignal = fetchStub.mock.calls[0]?.[1]?.signal as AbortSignal;
    vi.advanceTimersByTime(999);

    expect(passedSignal.aborted).toBe(false);
  });

  it("combines a caller-supplied signal via AbortSignal.any so it independently cancels", async () => {
    const timeoutFetch = createTimeoutFetch(1000);
    const callerController = new AbortController();
    const result = timeoutFetch("https://example.com", { signal: callerController.signal });
    result.catch(() => undefined);

    const passedSignal = fetchStub.mock.calls[0]?.[1]?.signal as AbortSignal;
    expect(passedSignal.aborted).toBe(false);

    callerController.abort(new Error("caller cancelled"));

    await expect(result).rejects.toBeDefined();
    expect(passedSignal.aborted).toBe(true);

    vi.advanceTimersByTime(1000);
  });

  it("uses only the internal timeout signal when the caller supplies none", () => {
    const timeoutFetch = createTimeoutFetch(1000);
    timeoutFetch("https://example.com").catch(() => undefined);

    const passedSignal = fetchStub.mock.calls[0]?.[1]?.signal as AbortSignal;
    expect(passedSignal).toBeInstanceOf(AbortSignal);

    vi.advanceTimersByTime(1000);
  });
});
