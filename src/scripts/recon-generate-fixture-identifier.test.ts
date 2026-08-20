import { describe, expect, it } from "vitest";
import { sanitizeFixtureIdentifier } from "@/scripts/recon-generate";

const IDENTIFIER_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

describe("sanitizeFixtureIdentifier", () => {
  it("leaves an already-valid identifier stem unchanged", () => {
    expect(sanitizeFixtureIdentifier("valid_name.json")).toBe("valid_name");
  });

  it("prefixes a digit-leading stem with 'fixture'", () => {
    expect(sanitizeFixtureIdentifier("10219132.json")).toBe("fixture10219132");
  });

  it("camelCases dot/dash separated stems", () => {
    expect(sanitizeFixtureIdentifier("acme-metrics.config.json")).toBe("acmeMetricsConfig");
  });

  it("prefixes with 'fixture' when camelCasing still leaves a digit-leading result", () => {
    expect(sanitizeFixtureIdentifier("9-lives.json")).toBe("fixture9Lives");
  });

  it("falls back to 'fixture' for a stem with no identifier characters at all", () => {
    expect(sanitizeFixtureIdentifier("...json")).toBe("fixture");
  });

  it("keeps a leading '$' or '_' untouched since both are valid identifier starts", () => {
    expect(sanitizeFixtureIdentifier("$config.json")).toBe("$config");
    expect(sanitizeFixtureIdentifier("_internal.json")).toBe("_internal");
  });

  it.each([
    "valid_name.json",
    "10219132.json",
    "acme-metrics.config.json",
    "9-lives.json",
    "...json",
    "$config.json",
    "mpulse-config.json",
  ])("always emits an identifier matching the isValidJsIdentifier pattern (%s)", (filename) => {
    expect(sanitizeFixtureIdentifier(filename)).toMatch(IDENTIFIER_PATTERN);
  });
});
