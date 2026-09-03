import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Guards CLAUDE.md's "site-agnostic core" rule for the required-control
 * escalation path: `hasUnfilledRequiredControlForStep`'s DOM query and
 * required-carve-out logic must only ever reference ARIA attributes and the
 * generic `PROMPT_TRIGGER_SELECTORS`-style trigger union, never a hardcoded
 * vendor/design-system class-name literal. This is a static-text property,
 * not a runtime behavior, so it's checked by scanning the source rather than
 * by exercising the code.
 */

const flowRunnerSource = readFileSync(join(__dirname, "flow-runner.ts"), "utf-8");

/** Slices the source between two markers that bracket a code block. */
function sliceBetween(source: string, startMarker: string, endMarker: string): string {
  const startIdx = source.indexOf(startMarker);
  expect(startIdx, `expected to find marker "${startMarker}" in flow-runner.ts`).toBeGreaterThan(
    -1
  );
  const endIdx = source.indexOf(endMarker, startIdx);
  expect(
    endIdx,
    `expected to find marker "${endMarker}" after "${startMarker}" in flow-runner.ts`
  ).toBeGreaterThan(-1);
  return source.slice(startIdx, endIdx);
}

const hasUnfilledRequiredControlForStepBlock = sliceBetween(
  flowRunnerSource,
  "export async function hasUnfilledRequiredControlForStep(",
  "\nexport async function "
);

// Vendor/design-system class-name literals CLAUDE.md forbids in
// site-agnostic core code. (Deliberately using unrelated examples per
// CLAUDE.md's no-site-mention rule for this repo.)
const VENDOR_CLASS_PATTERNS: RegExp[] = [/bb-custom/i, /dropdown-hide/i, /MultiCheckboxInput/];

describe("required-control escalation stays site-agnostic (flow-runner.ts)", () => {
  it("hasUnfilledRequiredControlForStep contains no vendor/design-system class-name literal", () => {
    for (const pattern of VENDOR_CLASS_PATTERNS) {
      expect(hasUnfilledRequiredControlForStepBlock).not.toMatch(pattern);
    }
  });
});
