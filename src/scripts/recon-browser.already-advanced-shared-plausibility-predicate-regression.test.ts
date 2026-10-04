/**
 * Regression coverage for the dedup refactor that made
 * `hasPageAlreadyAdvancedPastStep` delegate to the shared
 * `isPlausibleStepDestination` predicate instead of a private
 * `SIGN_IN_PATTERNS` check of its own. Re-asserts the exact two cases the
 * bug #13 short-circuit already covered pre-refactor, directly against
 * `hasPageAlreadyAdvancedPastStep`, and pins that `recon-browser.ts` no
 * longer defines its own copy of the pattern list.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { hasPageAlreadyAdvancedPastStep } from "@/scripts/recon-browser";

describe("hasPageAlreadyAdvancedPastStep — behavioral equivalence after converging on the shared predicate", () => {
  it("returns false when the live page bounced to a generic sign-in route and the step's own instruction is not about signing in", () => {
    const result = hasPageAlreadyAdvancedPastStep(
      "https://shop.example.com/checkout/profile",
      "https://shop.example.com/sign-in",
      "Click the Create Profile button to switch to account registration"
    );

    expect(result).toBe(false);
  });

  it("still returns true for a same-origin advance to an unrelated-but-non-auth path", () => {
    const result = hasPageAlreadyAdvancedPastStep(
      "https://apply.example.com/application/resume",
      "https://apply.example.com/application/review",
      "Upload the resume file"
    );

    expect(result).toBe(true);
  });

  it("recon-browser.ts no longer defines its own SIGN_IN_PATTERNS — only phantom-click.ts's shared copy remains", () => {
    const source = readFileSync(join(__dirname, "recon-browser.ts"), "utf8");

    expect(source).toMatch(
      /import\s*\{[^}]*\bisPlausibleStepDestination\b[^}]*\}\s*from\s*"@\/scraper\/phantom-click"/
    );
    expect(source).not.toMatch(/const\s+SIGN_IN_PATTERNS\s*=/);
  });
});
