import Bottleneck from "bottleneck";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod/v4";

import {
  HttpBotChallengeError,
  HttpRateLimitError,
  HttpSchemaError,
  HttpServerError,
  HttpUrlLockedError,
  OracleTokenExpiredError,
  UnknownScraperError,
} from "@/scraper/errors";
import type { HttpResponseBinding, HttpResponseInfo } from "@/scraper/http-client";
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
  const json = JSON.stringify(body);
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      status,
      ok,
      text: vi.fn().mockResolvedValue(json),
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

  it("retries on ORA_IRC_* sentinel body and throws OracleTokenExpiredError when all attempts fail", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        status: 200,
        ok: true,
        text: vi.fn().mockResolvedValue("ORA_IRC_TOKEN_EXPIRED"),
        headers: new Headers(),
      })
    );
    const client = makeClient();
    const rejection = client("https://example.com/api/item");
    await expect(rejection).rejects.toBeInstanceOf(OracleTokenExpiredError);
    await expect(rejection).rejects.not.toBeInstanceOf(HttpSchemaError);
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(3);
  });

  it("retries on ORA_IRC_* sentinel body and resolves when second attempt returns valid JSON", async () => {
    const validJson = JSON.stringify({ id: "1", name: "Widget" });
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce({
          status: 200,
          ok: true,
          text: vi.fn().mockResolvedValue("ORA_IRC_TOKEN_EXPIRED"),
          headers: new Headers(),
        })
        .mockResolvedValueOnce({
          status: 200,
          ok: true,
          text: vi.fn().mockResolvedValue(validJson),
          headers: new Headers(),
        })
    );
    const client = makeClient();
    const result = await client("https://example.com/api/item");
    expect(result).toEqual({ id: "1", name: "Widget" });
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
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

  it("throws HttpUrlLockedError on ORA_URL_LOCKED body — does NOT retry", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        status: 200,
        ok: true,
        text: vi.fn().mockResolvedValue("ORA_URL_LOCKED"),
        headers: new Headers(),
      })
    );
    const client = makeClient();
    await expect(client("https://example.com/api/item")).rejects.toBeInstanceOf(HttpUrlLockedError);
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
  });

  it("throws HttpUrlLockedError on ORA_URL_LOCKED body with trailing whitespace — does NOT retry", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        status: 200,
        ok: true,
        text: vi.fn().mockResolvedValue("ORA_URL_LOCKED\n"),
        headers: new Headers(),
      })
    );
    const client = makeClient();
    await expect(client("https://example.com/api/item")).rejects.toBeInstanceOf(HttpUrlLockedError);
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
  });

  it("retries on unknown ORA_* prefix (not IRC, not URL_LOCKED) — falls through to JSON parse", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        status: 200,
        ok: true,
        text: vi.fn().mockResolvedValue("ORA_SOME_FUTURE_CODE"),
        headers: new Headers(),
      })
    );
    const client = makeClient();
    await expect(client("https://example.com/api/item")).rejects.toBeInstanceOf(
      UnknownScraperError
    );
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(3);
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

  it("fires onResponse before throwing HttpUrlLockedError on ORA_URL_LOCKED", async () => {
    // onResponse fires at the HTTP layer (after fetch resolves) before sentinel
    // classification — callers that audit response headers still see the 200 even
    // when Oracle returns a locked-URL body.
    const responseHeaders = new Headers({ "x-oracle-request-id": "lock-42" });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        status: 200,
        ok: true,
        text: vi.fn().mockResolvedValue("ORA_URL_LOCKED"),
        headers: responseHeaders,
      })
    );

    const captured: HttpResponseInfo[] = [];
    const client = createHttpClient<Item>({
      schema: ItemSchema,
      bottleneck: passThruLimiter,
      baseHeaders: BASE_HEADERS,
      onResponse: (info) => captured.push(info),
    });

    await expect(client("https://example.com/api/item")).rejects.toBeInstanceOf(HttpUrlLockedError);

    expect(captured).toHaveLength(1);
    expect(captured[0]?.status).toBe(200);
    expect(captured[0]?.url).toBe("https://example.com/api/item");
    expect(captured[0]?.headers.get("x-oracle-request-id")).toBe("lock-42");
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
  });
});

describe("scraper/http-client response-header binding", () => {
  const AUTH_COOKIE_BINDING: HttpResponseBinding = {
    sourceHeader: "set-cookie",
    cookieName: "__pa",
    targetHeader: "Cookie",
  };

  it("forwards a value bound from call 1's Set-Cookie as a request header on call 2", async () => {
    const tokenResponseHeaders = new Headers();
    tokenResponseHeaders.append("Set-Cookie", "__pa=abc.def.ghi; Path=/; HttpOnly");

    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce({
          status: 200,
          ok: true,
          text: vi.fn().mockResolvedValue(JSON.stringify({ id: "1", name: "Widget" })),
          headers: tokenResponseHeaders,
        })
        .mockResolvedValueOnce({
          status: 200,
          ok: true,
          text: vi.fn().mockResolvedValue(JSON.stringify({ id: "2", name: "Gadget" })),
          headers: new Headers(),
        })
    );

    const client = createHttpClient<Item>({
      schema: ItemSchema,
      bottleneck: passThruLimiter,
      baseHeaders: BASE_HEADERS,
      bind: [AUTH_COOKIE_BINDING],
    });

    await client("https://example.com/authz/private", { method: "POST" });
    await client("https://example.com/available-products", { method: "POST" });

    const secondCall = vi.mocked(fetch).mock.calls[1];
    const secondCallHeaders = (secondCall?.[1] as RequestInit)?.headers as Record<string, string>;
    expect(secondCallHeaders.Cookie).toBe("abc.def.ghi");

    const firstCall = vi.mocked(fetch).mock.calls[0];
    const firstCallHeaders = (firstCall?.[1] as RequestInit)?.headers as Record<string, string>;
    expect(firstCallHeaders.Cookie).toBeUndefined();
  });

  it("does not fabricate an empty header when the bind source is absent from call 1's response", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce({
          status: 200,
          ok: true,
          text: vi.fn().mockResolvedValue(JSON.stringify({ id: "1", name: "Widget" })),
          headers: new Headers(),
        })
        .mockResolvedValueOnce({
          status: 200,
          ok: true,
          text: vi.fn().mockResolvedValue(JSON.stringify({ id: "2", name: "Gadget" })),
          headers: new Headers(),
        })
    );

    const client = createHttpClient<Item>({
      schema: ItemSchema,
      bottleneck: passThruLimiter,
      baseHeaders: BASE_HEADERS,
      bind: [AUTH_COOKIE_BINDING],
    });

    await client("https://example.com/authz/private", { method: "POST" });
    await client("https://example.com/available-products", { method: "POST" });

    const secondCall = vi.mocked(fetch).mock.calls[1];
    const secondCallHeaders = (secondCall?.[1] as RequestInit)?.headers as Record<string, string>;
    expect(secondCallHeaders.Cookie).toBeUndefined();
    expect("Cookie" in secondCallHeaders).toBe(false);
  });
});
