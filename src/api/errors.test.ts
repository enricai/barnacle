import { describe, expect, it } from "vitest";

import {
  ApiError,
  buildErrorEnvelope,
  CaptchaEncounteredError,
  FieldViolationError,
  httpStatusForCode,
  httpStatusString,
  ScrapeFailureError,
  ThrottledRequestError,
  UnauthorizedError,
  UrlLockedError,
} from "@/api/errors";
import { ERROR_CODES, statusSchema } from "@/api/schemas/common";

describe("api/errors", () => {
  describe("httpStatusForCode", () => {
    const cases: Array<[number, number]> = [
      [ERROR_CODES.PARTIAL_CONTENT_SUCCESS, 206],
      [ERROR_CODES.AUTHORIZATION_ERROR, 401],
      [ERROR_CODES.DECODING_ERROR, 400],
      [ERROR_CODES.FIELD_VIOLATION, 400],
      [ERROR_CODES.EMPTY_REQUEST, 400],
      [ERROR_CODES.RESOURCE_NOT_FOUND, 404],
      [ERROR_CODES.INDEX_NOT_FOUND, 404],
      [ERROR_CODES.THROTTLED_REQUEST, 429],
      [ERROR_CODES.URL_LOCKED, 429],
      [ERROR_CODES.TIME_OUT, 504],
      [ERROR_CODES.CLIENT_CALL_ERROR, 500],
      [ERROR_CODES.EXTRA_DETAIL, 500],
      [ERROR_CODES.SCRAPE_FAILURE, 500],
      [ERROR_CODES.CAPTCHA_ENCOUNTERED, 500],
      [ERROR_CODES.GENERIC_ERROR, 500],
    ];
    it.each(cases)("code %i → HTTP %i", (code, http) => {
      expect(httpStatusForCode(code as never)).toBe(http);
    });

    // Defensive fallback — if someone introduces a new error code and
    // forgets to add a branch, the default arm must still emit a 500
    // rather than leak undefined into Fastify's response path.
    it("falls back to 500 for an unknown code", () => {
      expect(httpStatusForCode(9999 as never)).toBe(500);
    });
  });

  describe("httpStatusString", () => {
    it("maps common statuses to upper-snake-case strings", () => {
      expect(httpStatusString(200)).toBe("OK");
      expect(httpStatusString(400)).toBe("BAD_REQUEST");
      expect(httpStatusString(401)).toBe("UNAUTHORIZED");
      expect(httpStatusString(404)).toBe("NOT_FOUND");
      expect(httpStatusString(429)).toBe("TOO_MANY_REQUESTS");
      expect(httpStatusString(500)).toBe("INTERNAL_SERVER_ERROR");
      expect(httpStatusString(504)).toBe("GATEWAY_TIMEOUT");
    });

    it("uses the RFC reason phrase for any valid status via http-status-codes", () => {
      expect(httpStatusString(418)).toBe("I_M_A_TEAPOT");
      expect(httpStatusString(418)).toMatch(/^[A-Z0-9_]+$/);
    });

    it("falls back to HTTP_<n> for statuses http-status-codes does not know", () => {
      expect(httpStatusString(999)).toBe("HTTP_999");
    });
  });

  describe("buildErrorEnvelope", () => {
    it("produces an envelope that parses through statusSchema", () => {
      const envelope = buildErrorEnvelope(ERROR_CODES.FIELD_VIOLATION, "bad field");
      const parsed = statusSchema.safeParse(envelope.status);
      expect(parsed.success).toBe(true);
      expect(envelope.status.httpStatus).toBe("BAD_REQUEST");
      expect(envelope.status.details[0]?.code).toBe(1002);
      expect(envelope.status.details[0]?.codeDescription).toBe("FIELD_VIOLATION");
      expect(envelope.status.details[0]?.message).toBe("bad field");
    });

    it("defaults detailType to ERROR", () => {
      const envelope = buildErrorEnvelope(ERROR_CODES.GENERIC_ERROR, "oops");
      expect(envelope.status.details[0]?.detailType).toBe("ERROR");
    });

    it("respects a custom detailType", () => {
      const envelope = buildErrorEnvelope(ERROR_CODES.EXTRA_DETAIL, "note", "INFO");
      expect(envelope.status.details[0]?.detailType).toBe("INFO");
    });
  });

  describe("ApiError subclasses", () => {
    it("each subclass carries the expected code", () => {
      expect(new UnauthorizedError().code).toBe(ERROR_CODES.AUTHORIZATION_ERROR);
      expect(new FieldViolationError("x").code).toBe(ERROR_CODES.FIELD_VIOLATION);
      expect(new ThrottledRequestError().code).toBe(ERROR_CODES.THROTTLED_REQUEST);
      expect(new UrlLockedError().code).toBe(ERROR_CODES.URL_LOCKED);
      expect(new ScrapeFailureError().code).toBe(ERROR_CODES.SCRAPE_FAILURE);
      expect(new CaptchaEncounteredError().code).toBe(ERROR_CODES.CAPTCHA_ENCOUNTERED);
    });

    it("subclasses are instanceof ApiError", () => {
      expect(new UnauthorizedError()).toBeInstanceOf(ApiError);
      expect(new FieldViolationError("x")).toBeInstanceOf(ApiError);
    });
  });
});
