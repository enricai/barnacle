import { describe, expect, it } from "vitest";
import { withClearBeforeType } from "./flow-runner";

describe("withClearBeforeType", () => {
  it("adds select-all/replace to a click-then-type rephrase", () => {
    const out = withClearBeforeType("Click the email input, then type a@example.com");
    expect(out).toMatch(/selecting all existing text/);
    expect(out.startsWith("Click the email input, then type a@example.com")).toBe(true);
  });
  it("is idempotent", () => {
    const once = withClearBeforeType("Click the email input and type a@example.com");
    expect(withClearBeforeType(once)).toBe(once);
  });
  it("leaves non-typing instructions unchanged", () => {
    expect(withClearBeforeType("Click the Continue button")).toBe("Click the Continue button");
  });
});
