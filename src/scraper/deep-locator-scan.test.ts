import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

import {
  buildScanFrameCandidatesExpr,
  type FrameCandidateScanResult,
  isNodeNotActionableError,
} from "@/scraper/deep-locator-scan";

/**
 * Minimal fake DOM element supporting exactly the surface the generated
 * expression touches (`textContent`, `getBoundingClientRect`) plus a
 * `computedStyle` bag the fake global `getComputedStyle` reads from — mirrors
 * `submit-control.test.ts`'s fixture shape (real generated expression string
 * against a hand-built tree, not a re-implementation of the traversal).
 */
interface FakeEl {
  textContent: string;
  rect: { width: number; height: number };
  computedStyle: { display: string; visibility: string };
  getBoundingClientRect(): { width: number; height: number };
}

interface FakeRoot {
  querySelectorAll(selector: string): FakeEl[];
}

function makeEl(
  textContent = "",
  overrides: Partial<{
    rect: { width: number; height: number };
    computedStyle: { display: string; visibility: string };
  }> = {}
): FakeEl {
  const rect = overrides.rect ?? { width: 100, height: 20 };
  const computedStyle = overrides.computedStyle ?? { display: "block", visibility: "visible" };
  return {
    textContent,
    rect,
    computedStyle,
    getBoundingClientRect() {
      return rect;
    },
  };
}

function makeRoot(matches: FakeEl[]): FakeRoot {
  return {
    querySelectorAll() {
      return matches;
    },
  };
}

/**
 * Executes a generated expression string against a fake `document` bound as
 * global `document`, plus a fake `getComputedStyle` that reads each fake
 * element's own `computedStyle` bag — the generated expression's only two
 * globals.
 */
function evaluateInFakePage(expr: string, document: FakeRoot): unknown {
  return runInNewContext(expr, {
    document,
    getComputedStyle: (el: FakeEl) => el.computedStyle,
    console,
  });
}

/**
 * Executes a generated expression string with `frameDocument` bound as
 * global `document` and the outer page's own fake root bound under a
 * different global name, simulating what `Frame.evaluate` does for real:
 * `document` resolves to the executing frame's document, never some outer
 * captured reference. If the builder ever referenced an outer `document`
 * instead of the supplied `root`, this fixture would surface it by finding
 * the outer page's elements instead of the frame's.
 */
function evaluateInFakeFrame(expr: string, frameDocument: FakeRoot, outerRoot: FakeRoot): unknown {
  return runInNewContext(expr, {
    document: frameDocument,
    __outerDocumentNeverReferenced: outerRoot,
    getComputedStyle: (el: FakeEl) => el.computedStyle,
    console,
  });
}

describe("deep-locator-scan/buildScanFrameCandidatesExpr", () => {
  it("returns one entry per querySelectorAll match, in document order, carrying {index, text, visible}", () => {
    const first = makeEl("First");
    const second = makeEl("Second");
    const third = makeEl("Third");
    const document = makeRoot([first, second, third]);

    const result = evaluateInFakePage(
      buildScanFrameCandidatesExpr("button"),
      document
    ) as FrameCandidateScanResult[];

    expect(result).toEqual([
      { index: 0, text: "First", visible: true },
      { index: 1, text: "Second", visible: true },
      { index: 2, text: "Third", visible: true },
    ]);
  });

  it("marks a 0x0 element visible:false while a laid-out sibling comes back visible:true", () => {
    const zeroSize = makeEl("Hidden", { rect: { width: 0, height: 0 } });
    const laidOut = makeEl("Shown");
    const document = makeRoot([zeroSize, laidOut]);

    const result = evaluateInFakePage(
      buildScanFrameCandidatesExpr("*"),
      document
    ) as FrameCandidateScanResult[];

    expect(result[0]).toEqual({ index: 0, text: "Hidden", visible: false });
    expect(result[1]).toEqual({ index: 1, text: "Shown", visible: true });
  });

  it("marks a display:none element visible:false while a laid-out sibling comes back visible:true", () => {
    const displayNone = makeEl("Hidden", {
      computedStyle: { display: "none", visibility: "visible" },
    });
    const laidOut = makeEl("Shown");
    const document = makeRoot([displayNone, laidOut]);

    const result = evaluateInFakePage(
      buildScanFrameCandidatesExpr("*"),
      document
    ) as FrameCandidateScanResult[];

    expect(result[0]?.visible).toBe(false);
    expect(result[1]?.visible).toBe(true);
  });

  it("marks a visibility:hidden element visible:false while a laid-out sibling comes back visible:true", () => {
    const visibilityHidden = makeEl("Hidden", {
      computedStyle: { display: "block", visibility: "hidden" },
    });
    const laidOut = makeEl("Shown");
    const document = makeRoot([visibilityHidden, laidOut]);

    const result = evaluateInFakePage(
      buildScanFrameCandidatesExpr("*"),
      document
    ) as FrameCandidateScanResult[];

    expect(result[0]?.visible).toBe(false);
    expect(result[1]?.visible).toBe(true);
  });

  it("returns an empty array when the selector matches nothing", () => {
    const document = makeRoot([]);

    const result = evaluateInFakePage(buildScanFrameCandidatesExpr("button"), document);

    expect(result).toEqual([]);
  });

  it("defaults to `document`, resolved from the executing realm (no root arg passed)", () => {
    const outerButton = makeEl("Outer");
    const outerDocument = makeRoot([outerButton]);
    const frameButton = makeEl("Inner");
    const frameDocument = makeRoot([frameButton]);

    const result = evaluateInFakeFrame(
      buildScanFrameCandidatesExpr("button"),
      frameDocument,
      outerDocument
    ) as FrameCandidateScanResult[];

    expect(result).toEqual([{ index: 0, text: "Inner", visible: true }]);
  });

  it("scans the frame-document-like tree via the root arg, ignoring the outer document", () => {
    const outerButton = makeEl("Outer");
    const outerDocument = makeRoot([outerButton]);
    const frameButton = makeEl("Inner");
    const frameDocument = makeRoot([frameButton]);

    const result = evaluateInFakeFrame(
      buildScanFrameCandidatesExpr("button", "document"),
      frameDocument,
      outerDocument
    ) as FrameCandidateScanResult[];

    expect(result).toEqual([{ index: 0, text: "Inner", visible: true }]);
  });
});

describe("deep-locator-scan/isNodeNotActionableError", () => {
  it('returns true for the CDP -32000 "no layout object" error message', () => {
    expect(isNodeNotActionableError(new Error("-32000 Node does not have a layout object"))).toBe(
      true
    );
  });

  it("returns true for an ElementNotVisibleError-shaped error", () => {
    const err = new Error("Element not visible (no box model): button");
    err.name = "ElementNotVisibleError";
    expect(isNodeNotActionableError(err)).toBe(true);
  });

  it("returns false for an ordinary error", () => {
    expect(isNodeNotActionableError(new Error("frame detached"))).toBe(false);
  });

  it("returns false for a WatchdogTimeoutError-shaped error", () => {
    const err = new Error("deepLocator click() for #foo >> nth=0 timed out after 10000ms");
    err.name = "WatchdogTimeoutError";
    expect(isNodeNotActionableError(err)).toBe(false);
  });

  it("returns false for a non-Error value", () => {
    expect(isNodeNotActionableError("-32000 Node does not have a layout object")).toBe(false);
  });
});
