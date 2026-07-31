import { describe, expect, it } from "vitest";

import { matchToOptions, SEMANTIC_EQUIVALENCES } from "@/lib/option-matcher";

describe("lib/option-matcher SEMANTIC_EQUIVALENCES", () => {
  it("exports a non-empty synonym table", () => {
    expect(Object.keys(SEMANTIC_EQUIVALENCES).length).toBeGreaterThan(0);
  });

  it("contains degree synonyms", () => {
    expect(SEMANTIC_EQUIVALENCES["master's degree"]).toContain("ms");
    expect(SEMANTIC_EQUIVALENCES["bachelor's degree"]).toContain("bs");
    expect(SEMANTIC_EQUIVALENCES["doctorate degree"]).toContain("phd");
  });

  it("contains gender/disclosure synonyms", () => {
    expect(SEMANTIC_EQUIVALENCES["i do not wish to disclose"]).toContain("decline");
    expect(SEMANTIC_EQUIVALENCES["i do not wish to disclose"]).toContain("prefer not to say");
  });
});

describe("lib/option-matcher matchToOptions", () => {
  it("returns rawValue unchanged when options list is empty", () => {
    expect(matchToOptions("Yes", [])).toBe("Yes");
  });

  it("returns rawValue unchanged when no string options exist", () => {
    expect(matchToOptions("Yes", [1, 2, 3])).toBe("Yes");
  });

  it("exact match — returns the matching option as-is", () => {
    const opts = ["Yes", "No", "Maybe"];
    expect(matchToOptions("Yes", opts)).toBe("Yes");
    expect(matchToOptions("No", opts)).toBe("No");
  });

  it("case-insensitive match — ignores case differences", () => {
    const opts = ["Yes", "No", "Maybe"];
    expect(matchToOptions("yes", opts)).toBe("Yes");
    expect(matchToOptions("NO", opts)).toBe("No");
    expect(matchToOptions("MAYBE", opts)).toBe("Maybe");
  });

  it("US state name→abbrev — resolves a full state name to its abbreviation option", () => {
    const opts = ["PA", "NY", "CA", "TX"];
    expect(matchToOptions("Pennsylvania", opts)).toBe("PA");
    expect(matchToOptions("new york", opts)).toBe("NY");
    expect(matchToOptions("california", opts)).toBe("CA");
  });

  it("semantic synonym — degree synonym maps to canonical option", () => {
    const opts = [
      "Master's Degree",
      "Bachelor's Degree",
      "Doctorate Degree",
      "High School Diploma/GED",
    ];
    expect(matchToOptions("ms", opts)).toBe("Master's Degree");
    expect(matchToOptions("bs", opts)).toBe("Bachelor's Degree");
    expect(matchToOptions("phd", opts)).toBe("Doctorate Degree");
    expect(matchToOptions("ged", opts)).toBe("High School Diploma/GED");
  });

  it("semantic synonym — gender/disclosure synonym maps to canonical option", () => {
    const opts = ["Male", "Female", "I do not wish to disclose"];
    expect(matchToOptions("decline", opts)).toBe("I do not wish to disclose");
    expect(matchToOptions("prefer not to say", opts)).toBe("I do not wish to disclose");
  });

  it("substring containment — rawValue substring of an option", () => {
    const opts = ["Full-Time Employment", "Part-Time Employment", "Contract"];
    expect(matchToOptions("Full-Time", opts)).toBe("Full-Time Employment");
  });

  it("substring containment — option substring of rawValue", () => {
    const opts = ["Contract", "Full-Time", "Part-Time"];
    expect(matchToOptions("Contract Position", opts)).toBe("Contract");
  });

  it("fallback to first option when no tier matches", () => {
    const opts = ["Alpha", "Beta", "Gamma"];
    expect(matchToOptions("zzzunmatched", opts)).toBe("Alpha");
  });

  it("trims leading/trailing whitespace before matching", () => {
    const opts = ["Yes", "No"];
    expect(matchToOptions("  Yes  ", opts)).toBe("Yes");
  });

  it("exact match takes priority over case-insensitive", () => {
    const opts = ["yes", "YES", "Yes"];
    expect(matchToOptions("yes", opts)).toBe("yes");
  });

  it("semantic synonym — higher degree synonyms map to canonical option", () => {
    const opts = ["Higher Degree (PHD/JD/MD/DO)", "Master's Degree", "Bachelor's Degree"];
    expect(matchToOptions("jd", opts)).toBe("Higher Degree (PHD/JD/MD/DO)");
    expect(matchToOptions("md", opts)).toBe("Higher Degree (PHD/JD/MD/DO)");
    expect(matchToOptions("j.d.", opts)).toBe("Higher Degree (PHD/JD/MD/DO)");
  });

  it("semantic synonym — associate degree synonyms map to canonical option", () => {
    const opts = ["Associate's Degree/College Diploma", "Bachelor's Degree", "Master's Degree"];
    expect(matchToOptions("aa", opts)).toBe("Associate's Degree/College Diploma");
    expect(matchToOptions("associates", opts)).toBe("Associate's Degree/College Diploma");
  });

  it("not coupled to any one plugin's payload shape — works with arbitrary plugin option sets", () => {
    // Boolean options; the helper must resolve without
    // any knowledge of the originating plugin's schema.
    const boolOpts = ["true", "false"];
    expect(matchToOptions("true", boolOpts)).toBe("true");
    expect(matchToOptions("false", boolOpts)).toBe("false");

    // Production-style enum with unrelated domain vocabulary.
    const shiftOpts = ["Day Shift", "Night Shift", "Rotating Shift"];
    expect(matchToOptions("day shift", shiftOpts)).toBe("Day Shift");
    expect(matchToOptions("Night", shiftOpts)).toBe("Night Shift");
  });
});
