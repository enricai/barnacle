import { describe, expect, it } from "vitest";
import { primitiveOptionLabel } from "@/scraper/flow-runner";

describe("primitiveOptionLabel", () => {
  it("logs only the length for fill-derived values", () => {
    const label = primitiveOptionLabel("SENTINEL-p4ssw0rd", "Password", undefined, true);
    expect(label).not.toContain("SENTINEL");
    expect(label).toContain("[17-char typed value]");
    expect(label).toContain('question "Password"');
  });

  it("keeps option text for non-fill steps", () => {
    expect(primitiveOptionLabel("United States", null)).toBe('option "United States"');
  });

  it("still masks the emailStep code", () => {
    expect(primitiveOptionLabel("123456", null, "123456")).toBe('option "[redacted]"');
  });
});
