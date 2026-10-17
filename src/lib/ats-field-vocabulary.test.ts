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
    ["CellPhoneNumber", "Phone"],
    ["MobileNumber", "Phone"],
    ["Telephone", "Phone"],
    ["PrimaryPhone", "Phone"],
    ["Address", "AddressLine"],
    ["Address1", "AddressLine"],
    ["StreetAddress1", "AddressLine"],
    ["Street Address Line 1", "AddressLine"],
  ])("resolves %s to %s", (label, expected) => {
    expect(resolveCanonicalAtsFieldName(label)).toBe(expected);
  });

  it("returns null for an unrelated label", () => {
    expect(resolveCanonicalAtsFieldName("Employer Name")).toBeNull();
  });

  it("does not map email, second-line, or other-entity address labels onto the base fields", () => {
    expect(resolveCanonicalAtsFieldName("EmailAddress")).toBeNull();
    expect(resolveCanonicalAtsFieldName("Address Line 2")).toBeNull();
    expect(resolveCanonicalAtsFieldName("Employer Address")).toBeNull();
  });

  it("resolves unlisted qualifier-only variants of phone and address", () => {
    expect(resolveCanonicalAtsFieldName("Daytime Phone Number")).toBe("Phone");
    expect(resolveCanonicalAtsFieldName("PreferredPhone")).toBe("Phone");
    expect(resolveCanonicalAtsFieldName("Permanent Address Line 1")).toBe("AddressLine");
    expect(resolveCanonicalAtsFieldName("PhysicalAddress")).toBe("AddressLine");
  });

  it("does not collapse labels naming a different attribute of the phone or address", () => {
    expect(resolveCanonicalAtsFieldName("Phone Type")).toBeNull();
    expect(resolveCanonicalAtsFieldName("Phone Country Code")).toBeNull();
    expect(resolveCanonicalAtsFieldName("Street Number")).toBeNull();
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
