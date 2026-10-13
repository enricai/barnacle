import { describe, expect, it } from "vitest";

import { spliceEmailStepFillValue } from "@/scraper/flow-runner";

describe("spliceEmailStepFillValue", () => {
  it("replaces a plain quoted value", () => {
    expect(spliceEmailStepFillValue("Fill the code field with '1234'", "999111")).toBe(
      "Fill the code field with '999111'"
    );
  });

  it("replaces a whole quoted value containing an apostrophe", () => {
    expect(spliceEmailStepFillValue("Fill the field with 'don't'", "999111")).toBe(
      "Fill the field with '999111'"
    );
  });

  it("appends when there is no quoted value", () => {
    expect(spliceEmailStepFillValue("Fill the code field", "999111")).toBe(
      "Fill the code field with '999111'"
    );
  });
});
