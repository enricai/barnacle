import { describe, expect, it } from "vitest";

import { stateToCode, US_STATE_NAMES } from "@/lib/us-states";

describe("lib/us-states US_STATE_NAMES", () => {
  it("resolves lowercase full state names to uppercase abbreviations", () => {
    expect(US_STATE_NAMES.pennsylvania).toBe("PA");
    expect(US_STATE_NAMES["new york"]).toBe("NY");
    expect(US_STATE_NAMES.california).toBe("CA");
    expect(US_STATE_NAMES["district of columbia"]).toBe("DC");
  });

  it("resolves all 5 US territories", () => {
    expect(US_STATE_NAMES["american samoa"]).toBe("AS");
    expect(US_STATE_NAMES.guam).toBe("GU");
    expect(US_STATE_NAMES["northern mariana islands"]).toBe("MP");
    expect(US_STATE_NAMES["puerto rico"]).toBe("PR");
    expect(US_STATE_NAMES["u.s. virgin islands"]).toBe("VI");
  });

  it("contains all 50 states + DC + 5 territories (56 keys total)", () => {
    expect(Object.keys(US_STATE_NAMES)).toHaveLength(56);
  });
});

describe("lib/us-states stateToCode", () => {
  it("resolves a lowercase full name", () => {
    expect(stateToCode("pennsylvania")).toBe("PA");
    expect(stateToCode("new york")).toBe("NY");
    expect(stateToCode("puerto rico")).toBe("PR");
  });

  it("is case-insensitive for full names", () => {
    expect(stateToCode("Pennsylvania")).toBe("PA");
    expect(stateToCode("NEW YORK")).toBe("NY");
    expect(stateToCode("Puerto Rico")).toBe("PR");
  });

  it("passes through an already-abbreviated 2-letter code uppercased", () => {
    expect(stateToCode("PA")).toBe("PA");
    expect(stateToCode("pa")).toBe("PA");
    expect(stateToCode("Ny")).toBe("NY");
  });

  it("returns the input unchanged when the name is not recognised", () => {
    expect(stateToCode("Unknown Territory")).toBe("Unknown Territory");
    expect(stateToCode("XY")).toBe("XY");
  });

  it("trims surrounding whitespace before matching", () => {
    expect(stateToCode(" ny ")).toBe("NY");
    expect(stateToCode("  pennsylvania  ")).toBe("PA");
    expect(stateToCode(" Unknown ")).toBe("Unknown");
  });
});
