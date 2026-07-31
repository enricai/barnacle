import { describe, expect, it } from "vitest";

import { MissingFormMapKeyError, ScraperError } from "@/scraper/errors";

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
