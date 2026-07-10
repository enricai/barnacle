import { fetch as undiciFetch } from "undici";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { HttpBotChallengeError, HttpSchemaError, HttpServerError } from "@/scraper/errors";
import { rawFetch } from "@/scraper/raw-fetch";
import { makeMockFetchResponse } from "@/testing/mock-fetch-response";

vi.mock("undici", () => ({
  fetch: vi.fn(),
}));

const mockFetch = vi.mocked(undiciFetch);

const BASE_URL = "https://example.com/api/resource";
const LABEL = "test/resource";

const RESPONSE_HEADERS = { "x-session-token": "rotated-token", "x-xsrf-token": "rotated-xsrf" };

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
      mockFetch.mockResolvedValueOnce(makeMockFetchResponse(200, '{"ok":true}', RESPONSE_HEADERS));
      const captured: Headers[] = [];
      await rawFetch(
        BASE_URL,
        makeOptions((h) => captured.push(h))
      );
      expect(captured).toHaveLength(1);
      expect(captured[0]?.get("x-session-token")).toBe("rotated-token");
    });

    it("calls onResponse with response headers on 401 before throwing", async () => {
      mockFetch.mockResolvedValueOnce(makeMockFetchResponse(401, "Unauthorized", RESPONSE_HEADERS));
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
      mockFetch.mockResolvedValueOnce(makeMockFetchResponse(500, "Server Error", RESPONSE_HEADERS));
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
      mockFetch.mockResolvedValueOnce(
        makeMockFetchResponse(422, "Unprocessable", RESPONSE_HEADERS)
      );
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
      mockFetch.mockResolvedValueOnce(makeMockFetchResponse(401, "Unauthorized", RESPONSE_HEADERS));
      await expect(rawFetch(BASE_URL, makeOptions())).rejects.toBeInstanceOf(HttpBotChallengeError);
    });

    it("throws HttpBotChallengeError on 403", async () => {
      mockFetch.mockResolvedValueOnce(makeMockFetchResponse(403, "Forbidden", RESPONSE_HEADERS));
      await expect(rawFetch(BASE_URL, makeOptions())).rejects.toBeInstanceOf(HttpBotChallengeError);
    });

    it("throws HttpServerError on 500", async () => {
      mockFetch.mockResolvedValueOnce(
        makeMockFetchResponse(500, "Internal Server Error", RESPONSE_HEADERS)
      );
      await expect(rawFetch(BASE_URL, makeOptions())).rejects.toBeInstanceOf(HttpServerError);
    });

    it("throws HttpServerError on 502", async () => {
      mockFetch.mockResolvedValueOnce(makeMockFetchResponse(502, "Bad Gateway", RESPONSE_HEADERS));
      await expect(rawFetch(BASE_URL, makeOptions())).rejects.toBeInstanceOf(HttpServerError);
    });

    it("throws HttpSchemaError on 422", async () => {
      mockFetch.mockResolvedValueOnce(
        makeMockFetchResponse(422, "Unprocessable Entity", RESPONSE_HEADERS)
      );
      await expect(rawFetch(BASE_URL, makeOptions())).rejects.toBeInstanceOf(HttpSchemaError);
    });

    it("throws HttpSchemaError on generic 4xx (e.g. 400)", async () => {
      mockFetch.mockResolvedValueOnce(makeMockFetchResponse(400, "Bad Request", RESPONSE_HEADERS));
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
      mockFetch.mockResolvedValueOnce(makeMockFetchResponse(200, body, RESPONSE_HEADERS));
      const result = await rawFetch(BASE_URL, makeOptions());
      expect(result.status).toBe(200);
      expect(result.rawBody).toBe(body);
    });

    it("returns { status, rawBody } on 201 without throwing", async () => {
      const body = '{"id":"new-resource"}';
      mockFetch.mockResolvedValueOnce(makeMockFetchResponse(201, body, RESPONSE_HEADERS));
      const result = await rawFetch(BASE_URL, makeOptions());
      expect(result.status).toBe(201);
      expect(result.rawBody).toBe(body);
    });

    it("passes method, headers, and body to undici fetch", async () => {
      mockFetch.mockResolvedValueOnce(makeMockFetchResponse(200, "{}", RESPONSE_HEADERS));
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

  // ORA_URL_LOCKED sentinel audit — intentional no-op on this seam:
  // rawFetch issues a fetch, fires onResponse, reads the body, and delegates
  // status classification to classifyHttpStatus. Oracle returns ORA_URL_LOCKED
  // as HTTP 200 with a plain-text body, so classifyHttpStatus returns silently
  // and rawFetch returns { status: 200, rawBody: "ORA_URL_LOCKED" } to the
  // caller. Sentinel detection is the responsibility of parseJsonResponse
  // (src/scraper/parse-json-response.ts), which is called downstream on the
  // createHttpClient hot path. rawFetch callers that use parseJsonResponse
  // inherit ORA_URL_LOCKED detection transitively; those that need raw Buffer
  // bodies and skip parseJsonResponse do not reach Oracle HCM endpoints, so
  // no gap exists in practice.
  describe("ORA_URL_LOCKED sentinel (200 with plain-text body)", () => {
    it("returns { status: 200, rawBody: 'ORA_URL_LOCKED' } without throwing — sentinel detection is parseJsonResponse's concern", async () => {
      mockFetch.mockResolvedValueOnce(
        makeMockFetchResponse(200, "ORA_URL_LOCKED", RESPONSE_HEADERS)
      );
      const result = await rawFetch(BASE_URL, makeOptions());
      expect(result.status).toBe(200);
      expect(result.rawBody).toBe("ORA_URL_LOCKED");
    });
  });

  describe("skipClassify", () => {
    it("returns { status, rawBody } without throwing on a 4xx when skipClassify is true", async () => {
      mockFetch.mockResolvedValueOnce(makeMockFetchResponse(401, "Unauthorized", RESPONSE_HEADERS));
      const result = await rawFetch(BASE_URL, {
        ...makeOptions(),
        skipClassify: true,
      });
      expect(result.status).toBe(401);
      expect(result.rawBody).toBe("Unauthorized");
    });

    it("returns { status, rawBody } without throwing on a 5xx when skipClassify is true", async () => {
      mockFetch.mockResolvedValueOnce(
        makeMockFetchResponse(500, "Internal Server Error", RESPONSE_HEADERS)
      );
      const result = await rawFetch(BASE_URL, {
        ...makeOptions(),
        skipClassify: true,
      });
      expect(result.status).toBe(500);
      expect(result.rawBody).toBe("Internal Server Error");
    });

    it("still calls onResponse before returning when skipClassify is true", async () => {
      mockFetch.mockResolvedValueOnce(makeMockFetchResponse(403, "Forbidden", RESPONSE_HEADERS));
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
