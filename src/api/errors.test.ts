import { describe, expect, it } from "vitest";

import {
  buildVpsEnvelope,
  CaptchaEncounteredError,
  FieldViolationError,
  httpStatusForCode,
  ScrapeFailureError,
  ThrottledRequestError,
  UnauthorizedError,
  VpsError,
  vpsHttpStatusString,
} from "@/api/errors";
import { VPS_ERROR_CODES, vpsStatusSchema } from "@/api/schemas/common";

describe("api/errors", () => {
  describe("httpStatusForCode", () => {
    const cases: Array<[number, number]> = [
      [VPS_ERROR_CODES.PARTIAL_CONTENT_SUCCESS, 206],
      [VPS_ERROR_CODES.AUTHORIZATION_ERROR, 401],
      [VPS_ERROR_CODES.DECODING_ERROR, 400],
      [VPS_ERROR_CODES.FIELD_VIOLATION, 400],
      [VPS_ERROR_CODES.EMPTY_REQUEST, 400],
      [VPS_ERROR_CODES.RESOURCE_NOT_FOUND, 404],
      [VPS_ERROR_CODES.INDEX_NOT_FOUND, 404],
      [VPS_ERROR_CODES.SAILING_NOT_FOUND, 404],
      [VPS_ERROR_CODES.SAILING_SOLD_OUT, 409],
      [VPS_ERROR_CODES.THROTTLED_REQUEST, 429],
      [VPS_ERROR_CODES.TIME_OUT, 504],
      [VPS_ERROR_CODES.CLIENT_CALL_ERROR, 500],
      [VPS_ERROR_CODES.EXTRA_DETAIL, 500],
      [VPS_ERROR_CODES.SCRAPE_FAILURE, 500],
      [VPS_ERROR_CODES.CAPTCHA_ENCOUNTERED, 500],
      [VPS_ERROR_CODES.GENERIC_ERROR, 500],
    ];
    it.each(cases)("code %i → HTTP %i", (code, http) => {
      expect(httpStatusForCode(code as never)).toBe(http);
    });

    // Defensive fallback — if someone introduces a new VPS code and
    // forgets to add a branch, the default arm must still emit a 500
    // rather than leak undefined into Fastify's response path.
    it("falls back to 500 for an unknown code", () => {
      expect(httpStatusForCode(9999 as never)).toBe(500);
    });
  });

  describe("vpsHttpStatusString", () => {
    it("maps common statuses to VPS strings", () => {
      expect(vpsHttpStatusString(200)).toBe("OK");
      expect(vpsHttpStatusString(400)).toBe("BAD_REQUEST");
      expect(vpsHttpStatusString(401)).toBe("UNAUTHORIZED");
      expect(vpsHttpStatusString(404)).toBe("NOT_FOUND");
      expect(vpsHttpStatusString(429)).toBe("TOO_MANY_REQUESTS");
      expect(vpsHttpStatusString(500)).toBe("INTERNAL_SERVER_ERROR");
      expect(vpsHttpStatusString(504)).toBe("GATEWAY_TIMEOUT");
    });

    it("uses the RFC reason phrase for any valid status via http-status-codes", () => {
      expect(vpsHttpStatusString(418)).toBe("I_M_A_TEAPOT");
      expect(vpsHttpStatusString(418)).toMatch(/^[A-Z0-9_]+$/);
    });

    it("falls back to HTTP_<n> for statuses http-status-codes does not know", () => {
      expect(vpsHttpStatusString(999)).toBe("HTTP_999");
    });
  });

  describe("buildVpsEnvelope", () => {
    it("produces an envelope that parses through vpsStatusSchema", () => {
      const envelope = buildVpsEnvelope(VPS_ERROR_CODES.FIELD_VIOLATION, "bad field");
      const parsed = vpsStatusSchema.safeParse(envelope.status);
      expect(parsed.success).toBe(true);
      expect(envelope.status.httpStatus).toBe("BAD_REQUEST");
      expect(envelope.status.details[0]?.code).toBe(1002);
      expect(envelope.status.details[0]?.codeDescription).toBe("FIELD_VIOLATION");
      expect(envelope.status.details[0]?.message).toBe("bad field");
    });

    it("defaults detailType to ERROR", () => {
      const envelope = buildVpsEnvelope(VPS_ERROR_CODES.GENERIC_ERROR, "oops");
      expect(envelope.status.details[0]?.detailType).toBe("ERROR");
    });

    it("respects a custom detailType", () => {
      const envelope = buildVpsEnvelope(VPS_ERROR_CODES.EXTRA_DETAIL, "note", "INFO");
      expect(envelope.status.details[0]?.detailType).toBe("INFO");
    });
  });

  describe("VpsError subclasses", () => {
    it("each subclass carries the expected code", () => {
      expect(new UnauthorizedError().code).toBe(VPS_ERROR_CODES.AUTHORIZATION_ERROR);
      expect(new FieldViolationError("x").code).toBe(VPS_ERROR_CODES.FIELD_VIOLATION);
      expect(new ThrottledRequestError().code).toBe(VPS_ERROR_CODES.THROTTLED_REQUEST);
      expect(new ScrapeFailureError().code).toBe(VPS_ERROR_CODES.SCRAPE_FAILURE);
      expect(new CaptchaEncounteredError().code).toBe(VPS_ERROR_CODES.CAPTCHA_ENCOUNTERED);
    });

    it("subclasses are instanceof VpsError", () => {
      expect(new UnauthorizedError()).toBeInstanceOf(VpsError);
      expect(new FieldViolationError("x")).toBeInstanceOf(VpsError);
    });
  });
});
