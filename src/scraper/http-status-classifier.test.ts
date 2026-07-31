import { describe, expect, it } from "vitest";

import {
  HttpBotChallengeError,
  HttpRateLimitError,
  HttpSchemaError,
  HttpServerError,
} from "@/scraper/errors";
import { classifyHttpStatus } from "@/scraper/http-status-classifier";

const LABEL = "test/endpoint";
const SNIPPET = "some body text";

describe("classifyHttpStatus", () => {
  it("throws HttpBotChallengeError on 401", () => {
    expect(() => classifyHttpStatus(401, SNIPPET, LABEL)).toThrow(HttpBotChallengeError);
  });

  it("throws HttpBotChallengeError on 403", () => {
    expect(() => classifyHttpStatus(403, SNIPPET, LABEL)).toThrow(HttpBotChallengeError);
  });

  it("throws HttpRateLimitError on 429", () => {
    expect(() => classifyHttpStatus(429, SNIPPET, LABEL)).toThrow(HttpRateLimitError);
  });

  it("throws HttpServerError on 500", () => {
    expect(() => classifyHttpStatus(500, SNIPPET, LABEL)).toThrow(HttpServerError);
  });

  it("throws HttpServerError on 502", () => {
    expect(() => classifyHttpStatus(502, SNIPPET, LABEL)).toThrow(HttpServerError);
  });

  it("throws HttpServerError on 503", () => {
    expect(() => classifyHttpStatus(503, SNIPPET, LABEL)).toThrow(HttpServerError);
  });

  it("throws HttpServerError on 504", () => {
    expect(() => classifyHttpStatus(504, SNIPPET, LABEL)).toThrow(HttpServerError);
  });

  it("throws HttpSchemaError on 422", () => {
    expect(() => classifyHttpStatus(422, SNIPPET, LABEL)).toThrow(HttpSchemaError);
  });

  it("throws HttpSchemaError on other 4xx (e.g. 400)", () => {
    expect(() => classifyHttpStatus(400, SNIPPET, LABEL)).toThrow(HttpSchemaError);
  });

  it("returns without throwing on 200", () => {
    expect(() => classifyHttpStatus(200, SNIPPET, LABEL)).not.toThrow();
  });

  it("includes contextLabel, status, and rawBodySnippet in the error message", () => {
    expect(() => classifyHttpStatus(403, SNIPPET, LABEL)).toThrow(
      `${LABEL} returned 403: ${SNIPPET}`
    );
  });

  it("does NOT throw for other 2xx statuses (e.g. 201, 204)", () => {
    expect(() => classifyHttpStatus(201, SNIPPET, LABEL)).not.toThrow();
    expect(() => classifyHttpStatus(204, SNIPPET, LABEL)).not.toThrow();
  });

  // ORA_URL_LOCKED sentinel audit — intentional no-op on this seam:
  // classifyHttpStatus is a pure numeric-status classifier. Oracle returns
  // ORA_URL_LOCKED as HTTP 200 with a plain-text body; this function returns
  // silently on any 2xx regardless of body content. Sentinel detection belongs
  // in parseJsonResponse (src/scraper/parse-json-response.ts), which is the
  // body-parsing seam on the createHttpClient hot path. Extending this function
  // to inspect body content would conflate two orthogonal concerns (status
  // classification vs. body interpretation) and would require a breaking
  // signature change for no benefit — no raw-fetch caller routes Oracle HCM
  // endpoints through this seam without also calling parseJsonResponse.
  it("returns without throwing for a 200 whose body is ORA_URL_LOCKED (sentinel detection is not this function's concern)", () => {
    expect(() => classifyHttpStatus(200, "ORA_URL_LOCKED", LABEL)).not.toThrow();
  });
});
