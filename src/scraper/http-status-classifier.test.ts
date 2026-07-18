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

  // Plain-text sentinel audit — intentional no-op on this seam:
  // classifyHttpStatus is a pure numeric-status classifier. A vendor that answers
  // with a plain-text sentinel at HTTP 200 returns silently here regardless of
  // body content. Body-sentinel detection belongs to a plugin's
  // `classifyResponseBody`/`classifyBody` on the createHttpClient hot path, not
  // to status classification — conflating the two orthogonal concerns would need
  // a breaking signature change for no benefit.
  it("returns without throwing for a 200 whose body is a plain-text sentinel (body detection is not this function's concern)", () => {
    expect(() => classifyHttpStatus(200, "PLUGIN_SENTINEL", LABEL)).not.toThrow();
  });
});
