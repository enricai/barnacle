import Bottleneck from "bottleneck";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod/v4";

import {
  HttpBotChallengeError,
  HttpRateLimitError,
  HttpSchemaError,
  HttpServerError,
  HttpUrlLockedError,
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

  // A plugin-supplied classifier stands in for a vendor sentinel body the engine
  // itself can't interpret. These exercise the generic seam, not any vendor's
  // wire format — the vendor-specific parity assertions live in the plugin.
  const RETRYABLE_BODY = "PLUGIN_TRANSIENT";
  const TERMINAL_BODY = "PLUGIN_TERMINAL";
  function makeClassifiedClient() {
    return createHttpClient<Item>({
      schema: ItemSchema,
      bottleneck: passThruLimiter,
      baseHeaders: BASE_HEADERS,
      classifyResponseBody: (rawText) => {
        const trimmed = rawText.trim();
        if (trimmed === TERMINAL_BODY) return new HttpUrlLockedError("locked by plugin");
        if (trimmed === RETRYABLE_BODY) return new UnknownScraperError("transient by plugin");
        return undefined;
      },
    });
  }
  function stubBody(body: string): void {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        status: 200,
        ok: true,
        text: vi.fn().mockResolvedValue(body),
        headers: new Headers(),
      })
    );
  }

  it("classifyResponseBody returning a retryable error retries, then throws it when all attempts fail", async () => {
    stubBody(RETRYABLE_BODY);
    const rejection = makeClassifiedClient()("https://example.com/api/item");
    await expect(rejection).rejects.toBeInstanceOf(UnknownScraperError);
    await expect(rejection).rejects.not.toBeInstanceOf(HttpSchemaError);
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(3);
  });

  it("classifyResponseBody retryable then a valid JSON body resolves without further retries", async () => {
    const validJson = JSON.stringify({ id: "1", name: "Widget" });
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce({
          status: 200,
          ok: true,
          text: vi.fn().mockResolvedValue(RETRYABLE_BODY),
          headers: new Headers(),
        })
        .mockResolvedValueOnce({
          status: 200,
          ok: true,
          text: vi.fn().mockResolvedValue(validJson),
          headers: new Headers(),
        })
    );
    const result = await makeClassifiedClient()("https://example.com/api/item");
    expect(result).toEqual({ id: "1", name: "Widget" });
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
  });

  it("classifyResponseBody returning a non-retryable error aborts immediately (no retry)", async () => {
    stubBody(TERMINAL_BODY);
    await expect(makeClassifiedClient()("https://example.com/api/item")).rejects.toBeInstanceOf(
      HttpUrlLockedError
    );
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
  });

  it("classifyResponseBody returning undefined falls through to JSON parsing (retryable non-JSON)", async () => {
    stubBody("SOME_UNCLASSIFIED_BODY");
    await expect(makeClassifiedClient()("https://example.com/api/item")).rejects.toBeInstanceOf(
      UnknownScraperError
    );
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(3);
  });

  it("with no classifier, a non-JSON body is a plain retryable parse failure", async () => {
    stubBody("not json at all");
    await expect(makeClient()("https://example.com/api/item")).rejects.toBeInstanceOf(
      UnknownScraperError
    );
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(3);
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

  it("passes the raw (untrimmed) body to classifyResponseBody so the plugin owns trimming", async () => {
    let seen: string | undefined;
    const client = createHttpClient<Item>({
      schema: ItemSchema,
      bottleneck: passThruLimiter,
      baseHeaders: BASE_HEADERS,
      classifyResponseBody: (rawText) => {
        seen = rawText;
        return rawText.trim() === TERMINAL_BODY ? new HttpUrlLockedError() : undefined;
      },
    });
    stubBody(`${TERMINAL_BODY}\n`);
    await expect(client("https://example.com/api/item")).rejects.toBeInstanceOf(HttpUrlLockedError);
    expect(seen).toBe(`${TERMINAL_BODY}\n`);
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

  it("fires onResponse before classifyResponseBody aborts the retry loop", async () => {
    // onResponse fires at the HTTP layer (after fetch resolves) before body
    // classification — callers auditing response headers still see the 200 even
    // when a classifier then raises a terminal sentinel.
    const responseHeaders = new Headers({ "x-request-id": "lock-42" });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        status: 200,
        ok: true,
        text: vi.fn().mockResolvedValue("PLUGIN_TERMINAL"),
        headers: responseHeaders,
      })
    );

    const captured: HttpResponseInfo[] = [];
    const client = createHttpClient<Item>({
      schema: ItemSchema,
      bottleneck: passThruLimiter,
      baseHeaders: BASE_HEADERS,
      onResponse: (info) => captured.push(info),
      classifyResponseBody: (rawText) =>
        rawText.trim() === "PLUGIN_TERMINAL" ? new HttpUrlLockedError() : undefined,
    });

    await expect(client("https://example.com/api/item")).rejects.toBeInstanceOf(HttpUrlLockedError);

    expect(captured).toHaveLength(1);
    expect(captured[0]?.status).toBe(200);
    expect(captured[0]?.url).toBe("https://example.com/api/item");
    expect(captured[0]?.headers.get("x-request-id")).toBe("lock-42");
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
    expect(secondCallHeaders.Cookie).toBe("__pa=abc.def.ghi");

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

  const GEO_COOKIE_BINDING: HttpResponseBinding = {
    sourceHeader: "set-cookie",
    cookieName: "latestWDPROGeoIP",
    targetHeader: "Cookie",
  };

  function headersWithSetCookies(...cookiePairs: string[]): Headers {
    const headers = new Headers();
    for (const pair of cookiePairs) headers.append("Set-Cookie", pair);
    return headers;
  }

  function cookieHeaderFromCall(callIndex: number): string | undefined {
    const call = vi.mocked(fetch).mock.calls[callIndex];
    const headers = (call?.[1] as RequestInit)?.headers as Record<string, string>;
    return headers.Cookie;
  }

  it("accumulates multiple cookie bindings sharing targetHeader Cookie into one header", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce({
          status: 200,
          ok: true,
          text: vi.fn().mockResolvedValue(JSON.stringify({ id: "1", name: "Widget" })),
          headers: headersWithSetCookies(
            "latestWDPROGeoIP=1.2.3.4; Path=/",
            "__pa=abc.def.ghi; Path=/; HttpOnly"
          ),
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
      bind: [GEO_COOKIE_BINDING, AUTH_COOKIE_BINDING],
    });

    await client("https://example.com/toggles", { method: "POST" });
    await client("https://example.com/available-products", { method: "POST" });

    const cookieHeader = cookieHeaderFromCall(1);
    expect(cookieHeader).toContain("latestWDPROGeoIP=1.2.3.4");
    expect(cookieHeader).toContain("__pa=abc.def.ghi");
    expect(cookieHeader).toBe("latestWDPROGeoIP=1.2.3.4; __pa=abc.def.ghi");
  });

  it("re-minting one cookie updates it in place without dropping the other bound cookie", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce({
          status: 200,
          ok: true,
          text: vi.fn().mockResolvedValue(JSON.stringify({ id: "1", name: "Widget" })),
          headers: headersWithSetCookies(
            "latestWDPROGeoIP=1.2.3.4; Path=/",
            "__pa=abc.def.ghi; Path=/; HttpOnly"
          ),
        })
        .mockResolvedValueOnce({
          status: 200,
          ok: true,
          text: vi.fn().mockResolvedValue(JSON.stringify({ id: "2", name: "Gadget" })),
          headers: headersWithSetCookies("__pa=xyz.rotated.token; Path=/; HttpOnly"),
        })
        .mockResolvedValueOnce({
          status: 200,
          ok: true,
          text: vi.fn().mockResolvedValue(JSON.stringify({ id: "3", name: "Sprocket" })),
          headers: new Headers(),
        })
    );

    const client = createHttpClient<Item>({
      schema: ItemSchema,
      bottleneck: passThruLimiter,
      baseHeaders: BASE_HEADERS,
      bind: [GEO_COOKIE_BINDING, AUTH_COOKIE_BINDING],
    });

    await client("https://example.com/toggles", { method: "POST" });
    await client("https://example.com/authz/private", { method: "POST" });
    await client("https://example.com/available-products", { method: "POST" });

    const cookieHeader = cookieHeaderFromCall(2);
    expect(cookieHeader).toContain("latestWDPROGeoIP=1.2.3.4");
    expect(cookieHeader).toContain("__pa=xyz.rotated.token");
    expect(cookieHeader).not.toContain("abc.def.ghi");
  });

  it("leaves prior bound cookie state intact when a later response is missing that cookie", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce({
          status: 200,
          ok: true,
          text: vi.fn().mockResolvedValue(JSON.stringify({ id: "1", name: "Widget" })),
          headers: headersWithSetCookies(
            "latestWDPROGeoIP=1.2.3.4; Path=/",
            "__pa=abc.def.ghi; Path=/; HttpOnly"
          ),
        })
        .mockResolvedValueOnce({
          status: 200,
          ok: true,
          text: vi.fn().mockResolvedValue(JSON.stringify({ id: "2", name: "Gadget" })),
          headers: new Headers(),
        })
        .mockResolvedValueOnce({
          status: 200,
          ok: true,
          text: vi.fn().mockResolvedValue(JSON.stringify({ id: "3", name: "Sprocket" })),
          headers: new Headers(),
        })
    );

    const client = createHttpClient<Item>({
      schema: ItemSchema,
      bottleneck: passThruLimiter,
      baseHeaders: BASE_HEADERS,
      bind: [GEO_COOKIE_BINDING, AUTH_COOKIE_BINDING],
    });

    await client("https://example.com/toggles", { method: "POST" });
    await client("https://example.com/no-cookies-here", { method: "POST" });
    await client("https://example.com/available-products", { method: "POST" });

    expect(cookieHeaderFromCall(2)).toBe("latestWDPROGeoIP=1.2.3.4; __pa=abc.def.ghi");
  });

  it("merges cookie bindings whose targetHeader differs only by case into one Cookie header", async () => {
    const CASE_VARIANT_GEO_BINDING: HttpResponseBinding = {
      sourceHeader: "set-cookie",
      cookieName: "latestWDPROGeoIP",
      targetHeader: "cookie",
    };

    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce({
          status: 200,
          ok: true,
          text: vi.fn().mockResolvedValue(JSON.stringify({ id: "1", name: "Widget" })),
          headers: headersWithSetCookies(
            "latestWDPROGeoIP=1.2.3.4; Path=/",
            "__pa=abc.def.ghi; Path=/; HttpOnly"
          ),
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
      bind: [CASE_VARIANT_GEO_BINDING, AUTH_COOKIE_BINDING],
    });

    await client("https://example.com/toggles", { method: "POST" });
    await client("https://example.com/available-products", { method: "POST" });

    const secondCall = vi.mocked(fetch).mock.calls[1];
    const secondCallHeaders = (secondCall?.[1] as RequestInit)?.headers as Record<string, string>;
    const cookieEntries = Object.entries(secondCallHeaders).filter(
      ([name]) => name.toLowerCase() === "cookie"
    );

    expect(cookieEntries).toHaveLength(1);
    const [, cookieValue] = cookieEntries[0] as [string, string];
    expect(cookieValue).toContain("latestWDPROGeoIP=");
    expect(cookieValue).toContain("__pa=");
  });

  it("non-cookie targetHeaders still overwrite as before, with no concatenation", async () => {
    const CONVERSATION_ID_BINDING: HttpResponseBinding = {
      sourceHeader: "x-conversation-id",
      targetHeader: "X-Conversation-Id",
    };

    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce({
          status: 200,
          ok: true,
          text: vi.fn().mockResolvedValue(JSON.stringify({ id: "1", name: "Widget" })),
          headers: new Headers({ "x-conversation-id": "conv-1" }),
        })
        .mockResolvedValueOnce({
          status: 200,
          ok: true,
          text: vi.fn().mockResolvedValue(JSON.stringify({ id: "2", name: "Gadget" })),
          headers: new Headers({ "x-conversation-id": "conv-2" }),
        })
        .mockResolvedValueOnce({
          status: 200,
          ok: true,
          text: vi.fn().mockResolvedValue(JSON.stringify({ id: "3", name: "Sprocket" })),
          headers: new Headers(),
        })
    );

    const client = createHttpClient<Item>({
      schema: ItemSchema,
      bottleneck: passThruLimiter,
      baseHeaders: BASE_HEADERS,
      bind: [CONVERSATION_ID_BINDING],
    });

    await client("https://example.com/step-1", { method: "POST" });
    await client("https://example.com/step-2", { method: "POST" });
    await client("https://example.com/step-3", { method: "POST" });

    const call = vi.mocked(fetch).mock.calls[2];
    const headers = (call?.[1] as RequestInit)?.headers as Record<string, string>;
    expect(headers["X-Conversation-Id"]).toBe("conv-2");
  });
});
