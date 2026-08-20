import { describe, expect, it } from "vitest";
import { resolveCanonicalAtsFieldName } from "@/lib/ats-field-vocabulary";

describe("resolveCanonicalAtsFieldName", () => {
  it.each([
    ["Mobile Phone", "Phone"],
    ["Phone Number", "Phone"],
    ["phoneNumber", "Phone"],
    ["Address Line 1", "AddressLine"],
    ["addressLine1", "AddressLine"],
    ["Zip", "PostalCode"],
    ["Postal Code", "PostalCode"],
    ["Legal First Name", "FirstName"],
    ["Given Name", "FirstName"],
    ["Legal Last Name", "LastName"],
    ["Surname", "LastName"],
    ["Family Name", "LastName"],
  ])("resolves %s to %s", (label, expected) => {
    expect(resolveCanonicalAtsFieldName(label)).toBe(expected);
  });

  it("returns null for an unrelated label", () => {
    expect(resolveCanonicalAtsFieldName("Employer Name")).toBeNull();
  });

  it("returns null for an empty string", () => {
    expect(resolveCanonicalAtsFieldName("")).toBeNull();
  });

  it("is case-insensitive and whitespace/punctuation tolerant", () => {
    expect(resolveCanonicalAtsFieldName("  MOBILE-phone  ")).toBe("Phone");
    expect(resolveCanonicalAtsFieldName("ZIP_CODE")).toBe("PostalCode");
  });

  it("does not match a longer label that merely contains a known synonym", () => {
    expect(resolveCanonicalAtsFieldName("Reference 1 Mobile Phone")).toBeNull();
  });
});
