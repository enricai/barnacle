import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Guards CLAUDE.md's "site-agnostic core" rule for the per-frame hCaptcha
 * callback-capture re-assert path: `installHcaptchaCallbackCaptureOnAllFrames`
 * must stay generic across every plugin/site, never branching on a site or
 * plugin identifier or naming a specific vendor. This is a static-text
 * property, not a runtime behavior, so it's checked by scanning the source
 * rather than by exercising the code.
 */

const captureSource = readFileSync(
  join(__dirname, "captcha-callback-capture.ts"),
  "utf-8"
);

/** Slices the source from a start marker to the end of the file. */
function sliceFrom(source: string, startMarker: string): string {
  const startIdx = source.indexOf(startMarker);
  expect(
    startIdx,
    `expected to find marker "${startMarker}" in captcha-callback-capture.ts`
  ).toBeGreaterThan(-1);
  return source.slice(startIdx);
}

const installOnAllFramesBlock = sliceFrom(
  captureSource,
  "export function installHcaptchaCallbackCaptureOnAllFrames("
);

// Per-site/plugin branch shapes CLAUDE.md forbids in site-agnostic core code.
const SITE_BRANCH_PATTERNS: RegExp[] = [
  /\bsiteId\s*===/,
  /\bplugin\.meta\.id\s*===/,
  /\bmeta\.id\s*===/,
];

// Known ATS/vendor names that would signal a hardcoded per-site branch if
// they ever appeared in this path; the re-assert logic must only ever know
// about the generic hCaptcha widget shape, never a named vendor.
// (Deliberately using unrelated domains as examples per CLAUDE.md's
// no-site-mention rule for this repo.)
const VENDOR_NAME_PATTERNS: RegExp[] = [/greenhouse/i, /lever/i, /workday/i, /icims/i, /taleo/i];

describe("per-frame hCaptcha callback-capture re-assert stays site-agnostic (captcha-callback-capture.ts)", () => {
  it("installHcaptchaCallbackCaptureOnAllFrames contains no site/plugin-identifying branch", () => {
    for (const pattern of SITE_BRANCH_PATTERNS) {
      expect(installOnAllFramesBlock).not.toMatch(pattern);
    }
    for (const pattern of VENDOR_NAME_PATTERNS) {
      expect(installOnAllFramesBlock).not.toMatch(pattern);
    }
  });

  it("only listens for generic Page.frameAttached/Page.frameNavigated CDP events, not a site identifier", () => {
    expect(installOnAllFramesBlock).not.toMatch(/\bsiteId\b/);
    expect(installOnAllFramesBlock).not.toMatch(/\bplugin\./);
  });
});
