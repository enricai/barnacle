import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  closeStagehandBounded,
  createTimeoutFetch,
  STAGEHAND_CLOSE_TIMEOUT_MS,
} from "@/scraper/session-shared";

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

describe("closeStagehandBounded", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("resolves and warns when close never settles", async () => {
    const logger = { warn: vi.fn() };
    const p = closeStagehandBounded({ close: () => new Promise<void>(() => {}) }, logger);
    await vi.advanceTimersByTimeAsync(STAGEHAND_CLOSE_TIMEOUT_MS);
    await expect(p).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it("warns and resolves when close rejects", async () => {
    const logger = { warn: vi.fn() };
    await expect(
      closeStagehandBounded({ close: () => Promise.reject(new Error("boom")) }, logger)
    ).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it("does not warn on a fast close", async () => {
    const logger = { warn: vi.fn() };
    await closeStagehandBounded({ close: () => Promise.resolve() }, logger);
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
