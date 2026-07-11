import { describe, expect, it } from "vitest";

import {
  HttpRateLimitError,
  HttpSchemaError,
  HttpUrlLockedError,
  MissingFormMapKeyError,
  type NeedsUserInfoResult,
  OracleTokenExpiredError,
  ScraperError,
  UnknownScraperError,
} from "@/scraper/errors";

describe("HttpUrlLockedError", () => {
  it("is non-retryable, instanceof ScraperError, and distinct from sibling Http errors", () => {
    const err = new HttpUrlLockedError();
    expect(err).toBeInstanceOf(ScraperError);
    expect(err.retryable).toBe(false);
    expect(err.name).toBe("HttpUrlLockedError");
    expect(err.message).toBe("oracle requisition url locked (ORA_URL_LOCKED)");
    expect(err).not.toBeInstanceOf(HttpRateLimitError);
    expect(err).not.toBeInstanceOf(HttpSchemaError);
    expect(err).not.toBeInstanceOf(OracleTokenExpiredError);
  });

  it("accepts a custom message", () => {
    const err = new HttpUrlLockedError("ORA_URL_LOCKED on j-12345");
    expect(err.message).toBe("ORA_URL_LOCKED on j-12345");
  });
});

describe("OracleTokenExpiredError", () => {
  it("is retryable, instanceof ScraperError, and distinct from sibling errors", () => {
    const err = new OracleTokenExpiredError();
    expect(err).toBeInstanceOf(ScraperError);
    expect(err.retryable).toBe(true);
    expect(err.name).toBe("OracleTokenExpiredError");
    expect(err.message).toBe("oracle token expired (ORA_IRC_TOKEN_EXPIRED)");
    expect(err).not.toBeInstanceOf(HttpUrlLockedError);
    expect(err).not.toBeInstanceOf(UnknownScraperError);
  });

  it("accepts a custom message", () => {
    const err = new OracleTokenExpiredError("ORA_IRC_TOKEN_EXPIRED on j-99999");
    expect(err.message).toBe("ORA_IRC_TOKEN_EXPIRED on j-99999");
  });
});

describe("MissingFormMapKeyError", () => {
  it("carries the missing keys + context and is non-retryable", () => {
    const err = new MissingFormMapKeyError(["firstName", "applicantGender"], "buildFormMap");
    expect(err).toBeInstanceOf(ScraperError);
    expect(err.missingKeys).toEqual(["firstName", "applicantGender"]);
    expect(err.context).toBe("buildFormMap");
    expect(err.retryable).toBe(false);
    expect(err.message).toBe(
      "form-map missing required keys [firstName, applicantGender] in buildFormMap"
    );
    expect(err.name).toBe("MissingFormMapKeyError");
  });
});

describe("NeedsUserInfoResult", () => {
  it("type-checks as a structured hot-path payload and reads back at runtime", () => {
    // Compile-time shape guard: the assignment below fails tsc if the type drifts.
    const result: NeedsUserInfoResult = {
      verified: false,
      needsUserInfo: true,
      missingFields: [
        { field: "educationLevel", question: "What is your highest level of education?" },
      ],
      requiresOtp: true,
    };

    expect(result.verified).toBe(false);
    expect(result.needsUserInfo).toBe(true);
    expect(result.missingFields).toEqual([
      { field: "educationLevel", question: "What is your highest level of education?" },
    ]);
    expect(result.requiresOtp).toBe(true);
  });
});
