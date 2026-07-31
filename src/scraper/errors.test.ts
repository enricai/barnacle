import { describe, expect, it } from "vitest";

import {
  HttpRateLimitError,
  HttpSchemaError,
  HttpUrlLockedError,
  MissingFormMapKeyError,
  type NeedsUserInfoResult,
  ScraperError,
  StepVerificationError,
  UnknownScraperError,
} from "@/scraper/errors";

describe("HttpUrlLockedError", () => {
  it("is non-retryable, instanceof ScraperError, and distinct from sibling Http errors", () => {
    const err = new HttpUrlLockedError();
    expect(err).toBeInstanceOf(ScraperError);
    expect(err.retryable).toBe(false);
    expect(err.name).toBe("HttpUrlLockedError");
    expect(err.message).toBe("requisition url locked");
    expect(err).not.toBeInstanceOf(HttpRateLimitError);
    expect(err).not.toBeInstanceOf(HttpSchemaError);
    expect(err).not.toBeInstanceOf(UnknownScraperError);
  });

  it("accepts a custom message", () => {
    const err = new HttpUrlLockedError("url locked on j-12345");
    expect(err.message).toBe("url locked on j-12345");
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

describe("StepVerificationError", () => {
  it("defaults to kind cascade-exhausted, is non-retryable, and instanceof ScraperError", () => {
    const err = new StepVerificationError();
    expect(err).toBeInstanceOf(ScraperError);
    expect(err.retryable).toBe(false);
    expect(err.name).toBe("StepVerificationError");
    expect(err.kind).toBe("cascade-exhausted");
  });

  it("constructs with kind phantom-click-exhausted and round-trips consistently with cascade-exhausted", () => {
    const phantomClick = new StepVerificationError(
      "step failed verification after all heal attempts",
      "phantom-click-exhausted"
    );
    expect(phantomClick).toBeInstanceOf(StepVerificationError);
    expect(phantomClick).toBeInstanceOf(ScraperError);
    expect(phantomClick.kind).toBe("phantom-click-exhausted");
    expect(phantomClick.retryable).toBe(false);
    expect(phantomClick.name).toBe("StepVerificationError");

    const cascadeExhausted = new StepVerificationError(
      "step failed verification after all heal attempts",
      "cascade-exhausted"
    );
    expect(phantomClick.retryable).toBe(cascadeExhausted.retryable);
    expect(phantomClick.name).toBe(cascadeExhausted.name);
    expect(phantomClick.kind).not.toBe(cascadeExhausted.kind);
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
