import { describe, expect, it } from "vitest";

import { httpStatusForCode } from "@/api/errors";
import {
  ERROR_CODE_DESCRIPTIONS,
  ERROR_CODES,
  needsUserInfoResponseSchema,
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
