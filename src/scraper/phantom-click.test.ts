import { describe, expect, it } from "vitest";
import { isPlausibleStepDestination, SIGN_IN_PATTERNS } from "@/scraper/phantom-click";

describe("isPlausibleStepDestination", () => {
  it("vetoes a sign-in-shaped path when the step instruction is not about signing in", () => {
    expect(
      isPlausibleStepDestination("click the Create Account button", "https://x.com/login")
    ).toBe(false);
  });

  it("credits a sign-in-shaped path when the step instruction is about signing in", () => {
    expect(isPlausibleStepDestination("click the Sign In button", "https://x.com/login")).toBe(
      true
    );
  });

  it("credits a non-sign-in-shaped path regardless of the step instruction", () => {
    expect(
      isPlausibleStepDestination("click the Create Account button", "https://x.com/register")
    ).toBe(true);
  });

  it("fails open on an unparseable postUrl", () => {
    expect(isPlausibleStepDestination("click the Create Account button", "not-a-url")).toBe(true);
  });

  it("exports SIGN_IN_PATTERNS", () => {
    expect(SIGN_IN_PATTERNS.length).toBeGreaterThan(0);
  });
});
