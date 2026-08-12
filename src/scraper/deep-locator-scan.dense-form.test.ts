import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

import {
  buildDenseFormFixture,
  DENSE_FORM_DECOY_TEXTS,
  DENSE_FORM_TARGET_TEXT,
  DENSE_FORM_TOTAL_COUNT,
  type FakeDomRoot,
} from "@/scraper/deep-locator-fake";
import {
  buildScanFrameCandidatesExpr,
  type FrameCandidateScanResult,
  INTERACTIVE_CANDIDATE_SELECTOR,
} from "@/scraper/deep-locator-scan";

/** The accessible names of every element the fixture's rendered, non-target, non-decoy controls carry — used to assert the exact interactive-scoped result set, not just its length. */
const EXPECTED_CONTROL_TEXTS = [
  "First Name",
  "Country",
  "Cover Letter",
  "Learn more",
  "Save Draft",
  "More options",
];

/**
 * Executes a generated expression string against a fake `document` bound as
 * global `document`, plus a fake `getComputedStyle` reading each fake
 * element's own `computedStyle` bag — matches `deep-locator-scan.test.ts`'s
 * own harness so this file proves the fix against a bigger, attribute-aware
 * fixture rather than reimplementing the execution seam.
 */
function evaluateInFakePage(expr: string, document: FakeDomRoot): unknown {
  return runInNewContext(expr, {
    document,
    getComputedStyle: (el: { computedStyle: unknown }) => el.computedStyle,
    console,
  });
}

describe("deep-locator-scan/buildScanFrameCandidatesExpr against a dense OOPIF-shaped form", () => {
  it(`scoping to INTERACTIVE_CANDIDATE_SELECTOR collapses the ${DENSE_FORM_TOTAL_COUNT}-node fixture to a handful of controls, excluding every structural node`, () => {
    const { root } = buildDenseFormFixture();

    const result = evaluateInFakePage(
      buildScanFrameCandidatesExpr(INTERACTIVE_CANDIDATE_SELECTOR),
      root
    ) as FrameCandidateScanResult[];

    expect(result.length).toBeLessThanOrEqual(10);
    const texts = result.map((candidate) => candidate.text).sort();
    expect(texts).toEqual(
      [...EXPECTED_CONTROL_TEXTS, DENSE_FORM_TARGET_TEXT, ...DENSE_FORM_DECOY_TEXTS].sort()
    );
  });

  it("includes the icon-only Manual Application button, its accessible name derived from aria-label since it has no textContent", () => {
    const { root } = buildDenseFormFixture();

    const result = evaluateInFakePage(
      buildScanFrameCandidatesExpr(INTERACTIVE_CANDIDATE_SELECTOR),
      root
    ) as FrameCandidateScanResult[];

    const target = result.find((candidate) => candidate.text === DENSE_FORM_TARGET_TEXT);
    expect(target).toBeDefined();
    expect(target?.visible).toBe(true);
  });

  it("marks the display:none and 0x0-rect decoys visible:false while every rendered control stays visible:true", () => {
    const { root } = buildDenseFormFixture();

    const result = evaluateInFakePage(
      buildScanFrameCandidatesExpr(INTERACTIVE_CANDIDATE_SELECTOR),
      root
    ) as FrameCandidateScanResult[];

    for (const decoyText of DENSE_FORM_DECOY_TEXTS) {
      const decoy = result.find((candidate) => candidate.text === decoyText);
      expect(decoy?.visible).toBe(false);
    }
    const renderedTexts = [...EXPECTED_CONTROL_TEXTS, DENSE_FORM_TARGET_TEXT];
    for (const text of renderedTexts) {
      const control = result.find((candidate) => candidate.text === text);
      expect(control?.visible).toBe(true);
    }
  });

  it(`control case: innerSelector "*" over the SAME fixture returns all ${DENSE_FORM_TOTAL_COUNT} entries, pinning the reduction as the selector's doing`, () => {
    const { root, elements } = buildDenseFormFixture();
    expect(elements).toHaveLength(DENSE_FORM_TOTAL_COUNT);

    const result = evaluateInFakePage(
      buildScanFrameCandidatesExpr("*"),
      root
    ) as FrameCandidateScanResult[];

    expect(result).toHaveLength(DENSE_FORM_TOTAL_COUNT);
  });
});
