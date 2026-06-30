import { fetch as undiciFetch } from "undici";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { HttpBotChallengeError, HttpSchemaError, HttpServerError } from "@/scraper/errors";
import { rawFetch } from "@/scraper/raw-fetch";

vi.mock("undici", () => ({
  fetch: vi.fn(),
}));

const mockFetch = vi.mocked(undiciFetch);

const BASE_URL = "https://example.com/api/resource";
const LABEL = "test/resource";

function makeResponse(status: number, body: string): Awaited<ReturnType<typeof undiciFetch>> {
  return {
    status,
    headers: new Headers({
      "x-session-token": "rotated-token",
      "x-xsrf-token": "rotated-xsrf",
    }),
    text: () => Promise.resolve(body),
  } as unknown as Awaited<ReturnType<typeof undiciFetch>>;
}

function makeOptions(onResponse: (h: Headers) => void = vi.fn()) {
  return {
    method: "GET",
    headers: { Accept: "application/json" },
    onResponse,
    contextLabel: LABEL,
  };
}

describe("rawFetch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("onResponse hook", () => {
    it("calls onResponse with response headers on a 200", async () => {
      mockFetch.mockResolvedValueOnce(makeResponse(200, '{"ok":true}'));
      const captured: Headers[] = [];
      await rawFetch(
        BASE_URL,
        makeOptions((h) => captured.push(h))
      );
      expect(captured).toHaveLength(1);
      expect(captured[0]?.get("x-session-token")).toBe("rotated-token");
    });

    it("calls onResponse with response headers on 401 before throwing", async () => {
      mockFetch.mockResolvedValueOnce(makeResponse(401, "Unauthorized"));
      const captured: Headers[] = [];
      await expect(
        rawFetch(
          BASE_URL,
          makeOptions((h) => captured.push(h))
        )
      ).rejects.toBeInstanceOf(HttpBotChallengeError);
      expect(captured).toHaveLength(1);
      expect(captured[0]?.get("x-session-token")).toBe("rotated-token");
    });

    it("calls onResponse with response headers on 500 before throwing", async () => {
      mockFetch.mockResolvedValueOnce(makeResponse(500, "Server Error"));
      const captured: Headers[] = [];
      await expect(
        rawFetch(
          BASE_URL,
          makeOptions((h) => captured.push(h))
        )
      ).rejects.toBeInstanceOf(HttpServerError);
      expect(captured).toHaveLength(1);
      expect(captured[0]?.get("x-xsrf-token")).toBe("rotated-xsrf");
    });

    it("calls onResponse with response headers on 422 before throwing", async () => {
      mockFetch.mockResolvedValueOnce(makeResponse(422, "Unprocessable"));
      const captured: Headers[] = [];
      await expect(
        rawFetch(
          BASE_URL,
          makeOptions((h) => captured.push(h))
        )
      ).rejects.toBeInstanceOf(HttpSchemaError);
      expect(captured).toHaveLength(1);
    });

    it("does NOT call onResponse when fetch throws a network error", async () => {
      mockFetch.mockRejectedValueOnce(new TypeError("ECONNRESET"));
      const onResponse = vi.fn();
      await expect(rawFetch(BASE_URL, makeOptions(onResponse))).rejects.toBeInstanceOf(
        HttpServerError
      );
      expect(onResponse).not.toHaveBeenCalled();
    });
  });

  describe("classifyHttpStatus delegation", () => {
    it("throws HttpBotChallengeError on 401", async () => {
      mockFetch.mockResolvedValueOnce(makeResponse(401, "Unauthorized"));
      await expect(rawFetch(BASE_URL, makeOptions())).rejects.toBeInstanceOf(HttpBotChallengeError);
    });

    it("throws HttpBotChallengeError on 403", async () => {
      mockFetch.mockResolvedValueOnce(makeResponse(403, "Forbidden"));
      await expect(rawFetch(BASE_URL, makeOptions())).rejects.toBeInstanceOf(HttpBotChallengeError);
    });

    it("throws HttpServerError on 500", async () => {
      mockFetch.mockResolvedValueOnce(makeResponse(500, "Internal Server Error"));
      await expect(rawFetch(BASE_URL, makeOptions())).rejects.toBeInstanceOf(HttpServerError);
    });

    it("throws HttpServerError on 502", async () => {
      mockFetch.mockResolvedValueOnce(makeResponse(502, "Bad Gateway"));
      await expect(rawFetch(BASE_URL, makeOptions())).rejects.toBeInstanceOf(HttpServerError);
    });

    it("throws HttpSchemaError on 422", async () => {
      mockFetch.mockResolvedValueOnce(makeResponse(422, "Unprocessable Entity"));
      await expect(rawFetch(BASE_URL, makeOptions())).rejects.toBeInstanceOf(HttpSchemaError);
    });

    it("throws HttpSchemaError on generic 4xx (e.g. 400)", async () => {
      mockFetch.mockResolvedValueOnce(makeResponse(400, "Bad Request"));
      await expect(rawFetch(BASE_URL, makeOptions())).rejects.toBeInstanceOf(HttpSchemaError);
    });
  });

  describe("network error wrapping", () => {
    it("wraps a network error in HttpServerError with contextLabel in message", async () => {
      mockFetch.mockRejectedValueOnce(new TypeError("socket hang up"));
      await expect(rawFetch(BASE_URL, makeOptions())).rejects.toThrow(
        `${LABEL} network error: socket hang up`
      );
    });

    it("wraps a network error as HttpServerError instance", async () => {
      mockFetch.mockRejectedValueOnce(new TypeError("socket hang up"));
      await expect(rawFetch(BASE_URL, makeOptions())).rejects.toBeInstanceOf(HttpServerError);
    });
  });

  describe("2xx success path", () => {
    it("returns { status, rawBody } verbatim without parsing on 200", async () => {
      const body = '{"key":"value","nested":{"a":1}}';
      mockFetch.mockResolvedValueOnce(makeResponse(200, body));
      const result = await rawFetch(BASE_URL, makeOptions());
      expect(result.status).toBe(200);
      expect(result.rawBody).toBe(body);
    });

    it("returns { status, rawBody } on 201 without throwing", async () => {
      const body = '{"id":"new-resource"}';
      mockFetch.mockResolvedValueOnce(makeResponse(201, body));
      const result = await rawFetch(BASE_URL, makeOptions());
      expect(result.status).toBe(201);
      expect(result.rawBody).toBe(body);
    });

    it("passes method, headers, and body to undici fetch", async () => {
      mockFetch.mockResolvedValueOnce(makeResponse(200, "{}"));
      await rawFetch(BASE_URL, {
        method: "POST",
        headers: { "Content-Type": "multipart/form-data" },
        body: Buffer.from("payload"),
        onResponse: vi.fn(),
        contextLabel: LABEL,
      });
      expect(mockFetch).toHaveBeenCalledWith(BASE_URL, {
        method: "POST",
        headers: { "Content-Type": "multipart/form-data" },
        body: Buffer.from("payload"),
      });
    });
  });

  describe("skipClassify", () => {
    it("returns { status, rawBody } without throwing on a 4xx when skipClassify is true", async () => {
      mockFetch.mockResolvedValueOnce(makeResponse(401, "Unauthorized"));
      const result = await rawFetch(BASE_URL, {
        ...makeOptions(),
        skipClassify: true,
      });
      expect(result.status).toBe(401);
      expect(result.rawBody).toBe("Unauthorized");
    });

    it("returns { status, rawBody } without throwing on a 5xx when skipClassify is true", async () => {
      mockFetch.mockResolvedValueOnce(makeResponse(500, "Internal Server Error"));
      const result = await rawFetch(BASE_URL, {
        ...makeOptions(),
        skipClassify: true,
      });
      expect(result.status).toBe(500);
      expect(result.rawBody).toBe("Internal Server Error");
    });

    it("still calls onResponse before returning when skipClassify is true", async () => {
      mockFetch.mockResolvedValueOnce(makeResponse(403, "Forbidden"));
      const captured: Headers[] = [];
      const result = await rawFetch(BASE_URL, {
        ...makeOptions((h) => captured.push(h)),
        skipClassify: true,
      });
      expect(captured).toHaveLength(1);
      expect(result.status).toBe(403);
    });
  });
});
