import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * CDP's Runtime.evaluate exceptionDetails.text is a generic classification
 * string Chrome always sets to "Uncaught", so the real error message/stack
 * only ever surfaces via exceptionDetails.exception.description. Without the
 * patch in patches/@browserbasehq__stagehand.patch, page.js's ||-chain tried
 * .text before .description (never falling through) and frame.js had no
 * .description fallback at all. This reads the patched dist files directly
 * (not a reimplementation) so a `pnpm install` that drops the patch fails
 * this test instead of passing silently.
 */
describe("Stagehand understudy evaluate() exceptionDetails precedence patch", () => {
  const requireStagehand = createRequire(__filename);
  const stagehandPackageRoot = dirname(
    requireStagehand.resolve("@browserbasehq/stagehand/package.json")
  );

  const extractExpression = (source: string, regex: RegExp, fileLabel: string): string => {
    const match = source.match(regex);
    if (!match) {
      throw new Error(
        `exceptionDetails message expression not found in ${fileLabel} — patch may need to be regenerated for a new Stagehand version`
      );
    }
    return match[1] as string;
  };

  const buildMessage = (expression: string): ((exceptionDetails: unknown) => string) =>
    new Function("exceptionDetails", `return (${expression});`) as (
      exceptionDetails: unknown
    ) => string;

  const pagePath = join(stagehandPackageRoot, "dist/cjs/lib/v3/understudy/page.js");
  const pageSource = readFileSync(pagePath, "utf8");
  const pageExpression = extractExpression(
    pageSource,
    /const msg = (exceptionDetails\.exception\?\.description \|\|\s*exceptionDetails\.text \|\|\s*"Evaluation failed");/,
    "page.js"
  );
  const buildPageMessage = buildMessage(pageExpression);

  const framePath = join(stagehandPackageRoot, "dist/cjs/lib/v3/understudy/frame.js");
  const frameSource = readFileSync(framePath, "utf8");
  const frameExpression = extractExpression(
    frameSource,
    /StagehandEvalError\((res\.exceptionDetails\.exception\?\.description \?\? res\.exceptionDetails\.text \?\? "Evaluation failed")\)/,
    "frame.js"
  );
  const buildFrameMessage = (exceptionDetails: unknown): string =>
    new Function("res", `return (${frameExpression});`)({ exceptionDetails }) as string;

  it.each([
    [
      "prefers the real description over the generic text",
      { text: "Uncaught", exception: { description: "TypeError: x is not a function" } },
      "TypeError: x is not a function",
    ],
    [
      "falls back to text when no description is present",
      { text: "Uncaught ReferenceError: y is not defined", exception: {} },
      "Uncaught ReferenceError: y is not defined",
    ],
    ["falls back to the static default when neither is present", {}, "Evaluation failed"],
  ] as const)("page.js: %s", (_label, exceptionDetails, expected) => {
    expect(buildPageMessage(exceptionDetails)).toBe(expected);
  });

  it.each([
    [
      "prefers the real description over the generic text",
      { text: "Uncaught", exception: { description: "TypeError: x is not a function" } },
      "TypeError: x is not a function",
    ],
    [
      "falls back to text when no description is present",
      { text: "Uncaught ReferenceError: y is not defined", exception: {} },
      "Uncaught ReferenceError: y is not defined",
    ],
    ["falls back to the static default when neither is present", {}, "Evaluation failed"],
  ] as const)("frame.js: %s", (_label, exceptionDetails, expected) => {
    expect(buildFrameMessage(exceptionDetails)).toBe(expected);
  });
});
