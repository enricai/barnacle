import Bottleneck from "bottleneck";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod/v4";

import {
  HttpBotChallengeError,
  HttpRateLimitError,
  HttpSchemaError,
  HttpServerError,
  UnknownScraperError,
} from "@/scraper/errors";
import type { HttpResponseInfo } from "@/scraper/http-client";
import { createHttpClient } from "@/scraper/http-client";

const passThruLimiter = new Bottleneck({ maxConcurrent: 1, minTime: 0 });

const BASE_HEADERS = {
  "Content-Type": "application/json",
  Accept: "application/json",
  Origin: "https://example.com",
  Referer: "https://example.com/",
  "User-Agent": "TestAgent/1.0",
};

const ItemSchema = z.object({ id: z.string(), name: z.string() });
type Item = z.infer<typeof ItemSchema>;

function makeClient() {
  return createHttpClient<Item>({
    schema: ItemSchema,
    bottleneck: passThruLimiter,
    baseHeaders: BASE_HEADERS,
  });
}

function mockFetch(
  status: number,
  body: unknown,
  ok = status >= 200 && status < 300,
  responseHeaders?: Headers
): void {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      status,
      ok,
      json: vi.fn().mockResolvedValue(body),
      headers: responseHeaders ?? new Headers(),
    })
  );
}

describe("scraper/http-client createHttpClient", () => {
  it("returns parsed data on a 200 with a valid schema", async () => {
    mockFetch(200, { id: "1", name: "Widget" });
    const client = makeClient();
    const result = await client("https://example.com/api/item");
    expect(result).toEqual({ id: "1", name: "Widget" });
  });

  it("throws HttpBotChallengeError on 401", async () => {
    mockFetch(401, {});
    const client = makeClient();
    await expect(client("https://example.com/api/item")).rejects.toBeInstanceOf(
      HttpBotChallengeError
    );
  });

  it("throws HttpBotChallengeError on 403", async () => {
    mockFetch(403, {});
    const client = makeClient();
    await expect(client("https://example.com/api/item")).rejects.toBeInstanceOf(
      HttpBotChallengeError
    );
  });

  it("throws HttpRateLimitError on 429", async () => {
    mockFetch(429, {});
    const client = makeClient();
    await expect(client("https://example.com/api/item")).rejects.toBeInstanceOf(HttpRateLimitError);
  });

  it("throws HttpServerError on 500", async () => {
    mockFetch(500, {});
    const client = makeClient();
    await expect(client("https://example.com/api/item")).rejects.toBeInstanceOf(HttpServerError);
  });

  it("throws HttpSchemaError when response does not match Zod schema", async () => {
    mockFetch(200, { id: 42, unexpected: true });
    const client = makeClient();
    await expect(client("https://example.com/api/item")).rejects.toBeInstanceOf(HttpSchemaError);
  });

  it("throws HttpSchemaError when response body is not valid JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        status: 200,
        ok: true,
        json: vi.fn().mockRejectedValue(new SyntaxError("Unexpected token")),
        headers: new Headers(),
      })
    );
    const client = makeClient();
    await expect(client("https://example.com/api/item")).rejects.toBeInstanceOf(HttpSchemaError);
  });

  it("retries on network-level failures (UnknownScraperError) and eventually throws", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("network failure")));
    const client = makeClient();
    // p-retry retries 2 times (3 total attempts) then propagates as UnknownScraperError
    await expect(client("https://example.com/api/item")).rejects.toBeInstanceOf(
      UnknownScraperError
    );
    // fetch should have been called 3 times total (1 original + 2 retries)
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(3);
  });

  it("does NOT retry on 401 — AbortError stops p-retry immediately", async () => {
    mockFetch(401, {});
    const client = makeClient();
    await expect(client("https://example.com/api/item")).rejects.toBeInstanceOf(
      HttpBotChallengeError
    );
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
  });

  it("does NOT retry on 429 — AbortError stops p-retry immediately", async () => {
    mockFetch(429, {});
    const client = makeClient();
    await expect(client("https://example.com/api/item")).rejects.toBeInstanceOf(HttpRateLimitError);
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
  });

  it("does NOT retry on schema mismatch — AbortError stops p-retry immediately", async () => {
    mockFetch(200, { wrong: "shape" });
    const client = makeClient();
    await expect(client("https://example.com/api/item")).rejects.toBeInstanceOf(HttpSchemaError);
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
  });

  it("merges init headers on top of baseHeaders", async () => {
    mockFetch(200, { id: "1", name: "Widget" });
    const client = makeClient();
    await client("https://example.com/api/item", {
      method: "POST",
      headers: { "X-Custom": "yes" },
      body: '{"q":1}',
    });
    const call = vi.mocked(fetch).mock.calls[0];
    const headers = (call?.[1] as RequestInit)?.headers as Record<string, string>;
    expect(headers["X-Custom"]).toBe("yes");
    expect(headers["Content-Type"]).toBe("application/json");
  });
});

describe("scraper/http-client onResponse hook", () => {
  it("fires with correct status, headers, and url on a 200 response", async () => {
    const responseHeaders = new Headers({ "x-request-id": "abc123" });
    mockFetch(200, { id: "1", name: "Widget" }, true, responseHeaders);

    const captured: HttpResponseInfo[] = [];
    const client = createHttpClient<Item>({
      schema: ItemSchema,
      bottleneck: passThruLimiter,
      baseHeaders: BASE_HEADERS,
      onResponse: (info) => captured.push(info),
    });

    await client("https://example.com/api/item");

    expect(captured).toHaveLength(1);
    expect(captured[0]?.status).toBe(200);
    expect(captured[0]?.url).toBe("https://example.com/api/item");
    expect(captured[0]?.headers.get("x-request-id")).toBe("abc123");
  });

  it("fires with correct status, headers, and url on a 403 response before throwing", async () => {
    const responseHeaders = new Headers({ "www-authenticate": "Bearer" });
    mockFetch(403, {}, false, responseHeaders);

    const captured: HttpResponseInfo[] = [];
    const client = createHttpClient<Item>({
      schema: ItemSchema,
      bottleneck: passThruLimiter,
      baseHeaders: BASE_HEADERS,
      onResponse: (info) => captured.push(info),
    });

    await expect(client("https://example.com/api/item")).rejects.toBeInstanceOf(
      HttpBotChallengeError
    );

    expect(captured).toHaveLength(1);
    expect(captured[0]?.status).toBe(403);
    expect(captured[0]?.url).toBe("https://example.com/api/item");
    expect(captured[0]?.headers.get("www-authenticate")).toBe("Bearer");
  });

  it("fires with correct status, headers, and url on a 500 response before throwing", async () => {
    const responseHeaders = new Headers({ "retry-after": "60" });
    mockFetch(500, {}, false, responseHeaders);

    const captured: HttpResponseInfo[] = [];
    const client = createHttpClient<Item>({
      schema: ItemSchema,
      bottleneck: passThruLimiter,
      baseHeaders: BASE_HEADERS,
      onResponse: (info) => captured.push(info),
    });

    await expect(client("https://example.com/api/item")).rejects.toBeInstanceOf(HttpServerError);

    expect(captured).toHaveLength(1);
    expect(captured[0]?.status).toBe(500);
    expect(captured[0]?.url).toBe("https://example.com/api/item");
    expect(captured[0]?.headers.get("retry-after")).toBe("60");
  });

  it("does not invoke onResponse when fetch throws a network error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("network failure")));

    const captured: HttpResponseInfo[] = [];
    const client = createHttpClient<Item>({
      schema: ItemSchema,
      bottleneck: passThruLimiter,
      baseHeaders: BASE_HEADERS,
      onResponse: (info) => captured.push(info),
    });

    await expect(client("https://example.com/api/item")).rejects.toBeInstanceOf(
      UnknownScraperError
    );
    expect(captured).toHaveLength(0);
  });
});
