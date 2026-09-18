import { describe, expect, it } from "vitest";
import { z } from "zod/v4";

import { httpStatusForCode } from "@/api/errors";
import {
  ERROR_CODE_DESCRIPTIONS,
  ERROR_CODES,
  facetValueSchema,
  needsUserInfoResponseSchema,
  occupancyWithinCapacitySchema,
  withOccupancyWithinCapacity,
} from "@/api/schemas/common";

describe("ERROR_CODES — new verification codes", () => {
  it("VERIFICATION_TRIGGER_FAILED is 2006", () => {
    expect(ERROR_CODES.VERIFICATION_TRIGGER_FAILED).toBe(2006);
  });

  it("RESUME_INVALID_OTP is 2007", () => {
    expect(ERROR_CODES.RESUME_INVALID_OTP).toBe(2007);
  });

  it("VERIFICATION_TRIGGER_FAILED appears in ERROR_CODE_DESCRIPTIONS", () => {
    expect(ERROR_CODE_DESCRIPTIONS[ERROR_CODES.VERIFICATION_TRIGGER_FAILED]).toBe(
      "VERIFICATION_TRIGGER_FAILED"
    );
  });

  it("RESUME_INVALID_OTP appears in ERROR_CODE_DESCRIPTIONS", () => {
    expect(ERROR_CODE_DESCRIPTIONS[ERROR_CODES.RESUME_INVALID_OTP]).toBe("RESUME_INVALID_OTP");
  });

  it("httpStatusForCode returns a non-500 status for RESUME_INVALID_OTP", () => {
    const status = httpStatusForCode(ERROR_CODES.RESUME_INVALID_OTP);
    expect(status).not.toBe(500);
    expect(status).toBe(400);
  });

  it("httpStatusForCode returns a defined status for VERIFICATION_TRIGGER_FAILED", () => {
    const status = httpStatusForCode(ERROR_CODES.VERIFICATION_TRIGGER_FAILED);
    expect(typeof status).toBe("number");
  });

  it("URL_LOCKED is 2008", () => {
    expect(ERROR_CODES.URL_LOCKED).toBe(2008);
  });

  it("URL_LOCKED appears in ERROR_CODE_DESCRIPTIONS", () => {
    expect(ERROR_CODE_DESCRIPTIONS[ERROR_CODES.URL_LOCKED]).toBe("URL_LOCKED");
  });

  it("httpStatusForCode returns 429 for URL_LOCKED", () => {
    expect(httpStatusForCode(ERROR_CODES.URL_LOCKED)).toBe(429);
  });
});

const validStatus = {
  httpStatus: "OK",
  dateTime: "2026-07-05T00:00:00.000Z",
  details: [],
};

describe("needsUserInfoResponseSchema", () => {
  it("parses a valid needs_user_info response", () => {
    const result = needsUserInfoResponseSchema.safeParse({
      status: validStatus,
      needsUserInfo: true,
      missingFields: [{ field: "educationLevel", question: "What is your highest education?" }],
      requiresOtp: true,
    });
    expect(result.success).toBe(true);
  });

  it("parses with an empty missingFields array", () => {
    const result = needsUserInfoResponseSchema.safeParse({
      status: validStatus,
      needsUserInfo: true,
      missingFields: [],
      requiresOtp: false,
    });
    expect(result.success).toBe(true);
  });

  it("parses with multiple missingFields", () => {
    const result = needsUserInfoResponseSchema.safeParse({
      status: validStatus,
      needsUserInfo: true,
      missingFields: [
        { field: "educationLevel", question: "What is your highest level of education?" },
        { field: "veteranStatus", question: "Are you a veteran?" },
      ],
      requiresOtp: true,
    });
    expect(result.success).toBe(true);
  });

  it("parses with an optional metrics payload", () => {
    const result = needsUserInfoResponseSchema.safeParse({
      status: validStatus,
      needsUserInfo: true,
      missingFields: [],
      requiresOtp: true,
      metrics: {
        totalDurationMs: 120,
        path: "http",
        steps: [{ step: "setup", durationMs: 5, status: "success" }],
        attemptCount: 1,
        startedAt: "2026-07-06T00:00:00Z",
        endedAt: "2026-07-06T00:00:01Z",
        recordedAt: "2026-07-06T00:00:01Z",
      },
    });
    expect(result.success).toBe(true);
  });

  it("parses when metrics is omitted (optional)", () => {
    const result = needsUserInfoResponseSchema.safeParse({
      status: validStatus,
      needsUserInfo: true,
      missingFields: [],
      requiresOtp: false,
    });
    expect(result.success).toBe(true);
  });

  it("rejects when requiresOtp is missing", () => {
    const result = needsUserInfoResponseSchema.safeParse({
      status: validStatus,
      needsUserInfo: true,
      missingFields: [],
    });
    expect(result.success).toBe(false);
  });

  it("rejects when needsUserInfo is false", () => {
    const result = needsUserInfoResponseSchema.safeParse({
      status: validStatus,
      needsUserInfo: false,
      missingFields: [],
      requiresOtp: false,
    });
    expect(result.success).toBe(false);
  });

  it("rejects when missingFields entries are missing required subfields", () => {
    const result = needsUserInfoResponseSchema.safeParse({
      status: validStatus,
      needsUserInfo: true,
      missingFields: [{ field: "educationLevel" }],
      requiresOtp: false,
    });
    expect(result.success).toBe(false);
  });

  it("rejects when status is missing", () => {
    const result = needsUserInfoResponseSchema.safeParse({
      needsUserInfo: true,
      missingFields: [],
      requiresOtp: false,
    });
    expect(result.success).toBe(false);
  });
});

describe("facetValueSchema", () => {
  const colorCodeSchema = facetValueSchema("colorCode", ["RED", "BLU", "GRN"]);

  it("accepts a value from the declared coded set", () => {
    const result = colorCodeSchema.safeParse("RED");
    expect(result.success).toBe(true);
  });

  it("rejects a free-text value not in the declared coded set", () => {
    const result = colorCodeSchema.safeParse("Red");
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain("colorCode must be one of");
  });

  it("surfaces the rejection as a ZodError the shared error handler maps to FIELD_VIOLATION", () => {
    expect(() => colorCodeSchema.parse("Red")).toThrowError(z.ZodError);
  });
});

describe("occupancyWithinCapacitySchema", () => {
  const partySizeSchema = occupancyWithinCapacitySchema("partySize", 4);

  it("accepts an occupancy count within the declared capacity", () => {
    expect(partySizeSchema.safeParse(4).success).toBe(true);
  });

  it("rejects an occupancy count exceeding the declared capacity", () => {
    const result = partySizeSchema.safeParse(5);
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain("must not exceed capacity of 4");
  });

  it("rejects a non-positive occupancy count", () => {
    expect(partySizeSchema.safeParse(0).success).toBe(false);
  });
});

describe("withOccupancyWithinCapacity", () => {
  const roomBookingSchema = withOccupancyWithinCapacity(
    z.object({
      partySize: z.number().int().positive(),
      roomCapacity: z.number().int().positive(),
    }),
    "partySize",
    "roomCapacity"
  );

  it("accepts an occupancy count within the request's own declared capacity field", () => {
    const result = roomBookingSchema.safeParse({ partySize: 3, roomCapacity: 4 });
    expect(result.success).toBe(true);
  });

  it("rejects an occupancy count exceeding the request's own declared capacity field", () => {
    const result = roomBookingSchema.safeParse({ partySize: 5, roomCapacity: 4 });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(["partySize"]);
    expect(result.error?.issues[0]?.message).toContain("must not exceed roomCapacity (4)");
  });
});
