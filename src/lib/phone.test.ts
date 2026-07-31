import { describe, expect, it } from "vitest";

import { parsePhone } from "@/lib/phone";

describe("lib/phone parsePhone", () => {
  it("splits a standard US phone into areaCode and number", () => {
    expect(parsePhone("555-123-4567")).toEqual({ areaCode: "555", number: "1234567" });
  });

  it("strips non-digit characters before splitting", () => {
    expect(parsePhone("(555) 123-4567")).toEqual({ areaCode: "555", number: "1234567" });
    expect(parsePhone("5551234567")).toEqual({ areaCode: "555", number: "1234567" });
  });

  it("returns empty areaCode when input has fewer than 10 digits", () => {
    expect(parsePhone("12345")).toEqual({ areaCode: "", number: "12345" });
    expect(parsePhone("123-456")).toEqual({ areaCode: "", number: "123456" });
  });

  it("returns empty areaCode and empty number for blank input", () => {
    expect(parsePhone("")).toEqual({ areaCode: "", number: "" });
  });

  it("handles exactly 10 digits at the boundary", () => {
    expect(parsePhone("5551234567")).toEqual({ areaCode: "555", number: "1234567" });
  });

  it("handles 11-digit numbers (country code prefix)", () => {
    expect(parsePhone("15551234567")).toEqual({ areaCode: "155", number: "51234567" });
  });
});
