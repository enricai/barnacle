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
  describe("SDK-route credential handling (url + init headers)", () => {
    const redirect = (location: string) =>
      new Response(null, { status: 307, headers: { location } });
    const headersOf = (i: number) => new Headers(fetchStub.mock.calls[i]?.[1]?.headers);

    it("forwards x-api-key and Authorization on a same-origin redirect", async () => {
      fetchStub
        .mockImplementationOnce(async () => redirect("https://example.com/b"))
        .mockImplementationOnce(async () => new Response("ok"));
      await createTimeoutFetch(1000)("https://example.com/a", {
        method: "POST",
        headers: { "x-api-key": "k", Authorization: "Bearer t" },
        body: "p",
      });
      expect(fetchStub).toHaveBeenCalledTimes(2);
      expect(headersOf(1).get("x-api-key")).toBe("k");
      expect(headersOf(1).get("authorization")).toBe("Bearer t");
    });

    it("strips x-api-key and Authorization on a cross-origin redirect", async () => {
      fetchStub
        .mockImplementationOnce(async () => redirect("https://other.example.net/b"))
        .mockImplementationOnce(async () => new Response("ok"));
      await createTimeoutFetch(1000)("https://example.com/a", {
        method: "POST",
        headers: { "x-api-key": "k", Authorization: "Bearer t", "content-type": "text/plain" },
        body: "p",
      });
      expect(fetchStub).toHaveBeenCalledTimes(2);
      expect(headersOf(0).get("x-api-key")).toBe("k");
      expect(headersOf(1).get("x-api-key")).toBeNull();
      expect(headersOf(1).get("authorization")).toBeNull();
      expect(headersOf(1).get("content-type")).toBe("text/plain");
    });
  });

  describe("Request input", () => {
    const ok = () => new Response("ok");
    const redirect = (location: string) =>
      new Response(null, { status: 307, headers: { location } });

    it("forwards method, headers and body to the first hop", async () => {
      fetchStub.mockImplementation(async () => ok());
      const req = new Request("https://example.com/a", {
        method: "POST",
        headers: { "x-api-key": "k", Authorization: "Bearer t" },
        body: "payload",
      });
      await createTimeoutFetch(1000)(req);
      const init = fetchStub.mock.calls[0]?.[1] as RequestInit;
      expect(init.method).toBe("POST");
      const h = new Headers(init.headers);
      expect(h.get("x-api-key")).toBe("k");
      expect(h.get("authorization")).toBe("Bearer t");
      expect(new TextDecoder().decode(init.body as ArrayBuffer)).toBe("payload");
    });

    it("strips credentials cross-origin but keeps method and body", async () => {
      fetchStub
        .mockImplementationOnce(async () => redirect("https://other.example.org/b"))
        .mockImplementationOnce(async () => ok());
      const req = new Request("https://example.com/a", {
        method: "POST",
        headers: { "x-api-key": "k", Authorization: "Bearer t", accept: "text/plain" },
        body: "payload",
      });
      await createTimeoutFetch(1000)(req);
      const init = fetchStub.mock.calls[1]?.[1] as RequestInit;
      const h = new Headers(init.headers);
      expect(h.get("x-api-key")).toBeNull();
      expect(h.get("authorization")).toBeNull();
      expect(h.get("accept")).toBe("text/plain");
      expect(init.method).toBe("POST");
      expect(new TextDecoder().decode(init.body as ArrayBuffer)).toBe("payload");
    });

    it("keeps every header on a same-origin redirect", async () => {
      fetchStub
        .mockImplementationOnce(async () => redirect("/b"))
        .mockImplementationOnce(async () => ok());
      const req = new Request("https://example.com/a", {
        method: "POST",
        headers: { "x-api-key": "k" },
        body: "p",
      });
      await createTimeoutFetch(1000)(req);
      const h = new Headers((fetchStub.mock.calls[1]?.[1] as RequestInit | undefined)?.headers);
      expect(h.get("x-api-key")).toBe("k");
    });

    it("lets init override the Request's method", async () => {
      fetchStub.mockImplementation(async () => ok());
      await createTimeoutFetch(1000)(new Request("https://example.com/a", { method: "DELETE" }), {
        method: "PUT",
      });
      expect((fetchStub.mock.calls[0]?.[1] as RequestInit | undefined)?.method).toBe("PUT");
    });
  });

  it("passes URL and string inputs through as before", async () => {
    fetchStub.mockImplementation(async () => new Response("ok"));
    await createTimeoutFetch(1000)(new URL("https://example.com/u"));
    await createTimeoutFetch(1000)("https://example.com/s", { method: "POST" });
    expect(fetchStub.mock.calls[0]?.[0]).toBe("https://example.com/u");
    expect(fetchStub.mock.calls[1]?.[0]).toBe("https://example.com/s");
    expect((fetchStub.mock.calls[1]?.[1] as RequestInit | undefined)?.method).toBe("POST");
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
