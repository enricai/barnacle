import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Guards CLAUDE.md's "site-agnostic core" rule for the captcha hand-off
 * path specifically: `dispatch()`/`registerRoutes()` are called out by name
 * in the doc, but the same principle applies to
 * `injectCaptchaTokenAndSubmit`/`submitCaptchaGatedForm` and the
 * `captchaGated` block in `executeStepWithHealing` — none of them may branch
 * on a site or plugin identifier. This is a static-text property, not a
 * runtime behavior, so it's checked by scanning the source rather than by
 * exercising the code.
 */

const flowRunnerSource = readFileSync(join(__dirname, "flow-runner.ts"), "utf-8");

/** Slices the source between two doc-comment markers that bracket a captcha-gated code path. */
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

const injectCaptchaTokenAndSubmitBlock = sliceBetween(
  flowRunnerSource,
  "export async function injectCaptchaTokenAndSubmit(",
  "\nexport async function submitCaptchaGatedForm("
);

const submitCaptchaGatedFormBlock = sliceBetween(
  flowRunnerSource,
  "export async function submitCaptchaGatedForm(",
  "\nexport interface"
);

const captchaGatedHookBlock = sliceBetween(
  flowRunnerSource,
  "// Captcha-gated submit hook. Fires ONLY on a submit/final-shaped step",
  "\n  // Snapshot the capture-meta tail length at step entry."
);

// Per-site/plugin branch shapes CLAUDE.md forbids in site-agnostic core code.
const SITE_BRANCH_PATTERNS: RegExp[] = [
  /\bsiteId\s*===/,
  /\bplugin\.meta\.id\s*===/,
  /\bmeta\.id\s*===/,
];

// Known ATS/vendor names that would signal a hardcoded per-site branch if
// they ever appeared in this path; the hook must only ever know about the
// generic hCaptcha widget shape ([data-sitekey]/data-callback), never a
// named vendor. (Deliberately using unrelated domains as examples per
// CLAUDE.md's no-site-mention rule for this repo.)
const VENDOR_NAME_PATTERNS: RegExp[] = [/greenhouse/i, /lever/i, /workday/i, /icims/i, /taleo/i];

describe("captcha hand-off stays site-agnostic (flow-runner.ts)", () => {
  it.each([
    ["injectCaptchaTokenAndSubmit", injectCaptchaTokenAndSubmitBlock],
    ["submitCaptchaGatedForm", submitCaptchaGatedFormBlock],
    ["captchaGated hook in executeStepWithHealing", captchaGatedHookBlock],
  ])("%s contains no site/plugin-identifying branch", (_label, block) => {
    for (const pattern of SITE_BRANCH_PATTERNS) {
      expect(block).not.toMatch(pattern);
    }
    for (const pattern of VENDOR_NAME_PATTERNS) {
      expect(block).not.toMatch(pattern);
    }
  });

  it("the captchaGated hook only branches on the generic `captchaGated` flag and step shape, not a site identifier", () => {
    expect(captchaGatedHookBlock).not.toMatch(/\bsiteId\b/);
    expect(captchaGatedHookBlock).not.toMatch(/\bplugin\./);
  });
});
