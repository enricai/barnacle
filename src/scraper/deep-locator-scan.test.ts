import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

import {
  buildScanFrameCandidatesExpr,
  type FrameCandidateScanResult,
  isNodeNotActionableError,
} from "@/scraper/deep-locator-scan";

/**
 * Minimal fake DOM element supporting exactly the surface the generated
 * expression touches (`textContent`, `getBoundingClientRect`, `getAttribute`,
 * `closest`) plus a `computedStyle` bag the fake global `getComputedStyle`
 * reads from — mirrors `submit-control.test.ts`'s fixture shape (real
 * generated expression string against a hand-built tree, not a
 * re-implementation of the traversal).
 */
interface FakeEl {
  textContent: string;
  rect: { width: number; height: number };
  computedStyle: { display: string; visibility: string };
  tagName: string;
  attributes: Record<string, string>;
  parent: FakeEl | null;
  getBoundingClientRect(): { width: number; height: number };
  getAttribute(name: string): string | null;
  closest(selector: string): FakeEl | null;
}

/** Fake `document`/frame-document surface: tag-filtered `querySelectorAll` plus `getElementById`, the two lookups the accessible-name precedence chain needs beyond the matched candidate set itself. */
interface FakeRoot {
  querySelectorAll(selector: string): FakeEl[];
  getElementById(id: string): FakeEl | null;
}

function makeEl(
  textContent = "",
  overrides: Partial<{
    rect: { width: number; height: number };
    computedStyle: { display: string; visibility: string };
    tagName: string;
    attributes: Record<string, string>;
    parent: FakeEl | null;
  }> = {}
): FakeEl {
  const rect = overrides.rect ?? { width: 100, height: 20 };
  const computedStyle = overrides.computedStyle ?? { display: "block", visibility: "visible" };
  const tagName = overrides.tagName ?? "button";
  const attributes = overrides.attributes ?? {};
  const parent = overrides.parent ?? null;
  const el: FakeEl = {
    textContent,
    rect,
    computedStyle,
    tagName,
    attributes,
    parent,
    getBoundingClientRect() {
      return rect;
    },
    getAttribute(name) {
      return attributes[name] ?? null;
    },
    closest(selector) {
      let node: FakeEl | null = el;
      while (node) {
        if (node.tagName === selector) return node;
        node = node.parent;
      }
      return null;
    },
  };
  return el;
}

/**
 * `elements` is the full flat registry the fake root resolves against — the
 * candidates a caller wants `querySelectorAll(innerSelector)` to match PLUS
 * any other elements (a `<label>`, an `aria-labelledby` target) the
 * accessible-name precedence chain looks up but the outer scan doesn't
 * itself match. Both `querySelectorAll` and `getElementById` filter/search
 * this same registry, mirroring how a real DOM has one tree underneath every
 * lookup method.
 */
function makeRoot(elements: FakeEl[]): FakeRoot {
  return {
    querySelectorAll(selector) {
      const tags = selector.split(",").map((s) => s.trim().toLowerCase());
      if (tags.includes("*")) return elements;
      return elements.filter((el) => tags.includes(el.tagName.toLowerCase()));
    },
    getElementById(id) {
      return elements.find((el) => el.getAttribute("id") === id) ?? null;
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

describe("deep-locator-scan/buildScanFrameCandidatesExpr accessible-name derivation", () => {
  it("derives text from aria-label when textContent is empty, as on an <input>", () => {
    const input = makeEl("", { tagName: "input", attributes: { "aria-label": "First Name" } });
    const document = makeRoot([input]);

    const result = evaluateInFakePage(
      buildScanFrameCandidatesExpr("input"),
      document
    ) as FrameCandidateScanResult[];

    expect(result).toEqual([{ index: 0, text: "First Name", visible: true }]);
  });

  it("falls back to placeholder when there is no aria-label/labelledby/label and no textContent", () => {
    const input = makeEl("", { tagName: "input", attributes: { placeholder: "Email Address" } });
    const document = makeRoot([input]);

    const result = evaluateInFakePage(
      buildScanFrameCandidatesExpr("input"),
      document
    ) as FrameCandidateScanResult[];

    expect(result).toEqual([{ index: 0, text: "Email Address", visible: true }]);
  });

  it("falls back to title for an icon-only button with no text, aria-label, or placeholder", () => {
    const button = makeEl("", { tagName: "button", attributes: { title: "Close" } });
    const document = makeRoot([button]);

    const result = evaluateInFakePage(
      buildScanFrameCandidatesExpr("button"),
      document
    ) as FrameCandidateScanResult[];

    expect(result).toEqual([{ index: 0, text: "Close", visible: true }]);
  });

  it("still yields unchanged textContent for a text-bearing button (no regression)", () => {
    const button = makeEl("Submit Application");
    const document = makeRoot([button]);

    const result = evaluateInFakePage(
      buildScanFrameCandidatesExpr("button"),
      document
    ) as FrameCandidateScanResult[];

    expect(result).toEqual([{ index: 0, text: "Submit Application", visible: true }]);
  });

  it("derives text from an associated label[for=id] when there is no aria-label/labelledby and no textContent", () => {
    const input = makeEl("", { tagName: "input", attributes: { id: "fname" } });
    const label = makeEl("First Name", { tagName: "label", attributes: { for: "fname" } });
    const document = makeRoot([input, label]);

    const result = evaluateInFakePage(
      buildScanFrameCandidatesExpr("input"),
      document
    ) as FrameCandidateScanResult[];

    expect(result).toEqual([{ index: 0, text: "First Name", visible: true }]);
  });

  it("derives text from the nearest ancestor <label> when the input has no id/for association", () => {
    const label = makeEl("Last Name", { tagName: "label" });
    const input = makeEl("", { tagName: "input", parent: label });
    const document = makeRoot([input, label]);

    const result = evaluateInFakePage(
      buildScanFrameCandidatesExpr("input"),
      document
    ) as FrameCandidateScanResult[];

    expect(result).toEqual([{ index: 0, text: "Last Name", visible: true }]);
  });

  it("derives text from aria-labelledby, resolving the referenced id against root", () => {
    const input = makeEl("", {
      tagName: "input",
      attributes: { "aria-labelledby": "fname-label" },
    });
    const labelSpan = makeEl("First Name", { tagName: "span", attributes: { id: "fname-label" } });
    const document = makeRoot([input, labelSpan]);

    const result = evaluateInFakePage(
      buildScanFrameCandidatesExpr("input"),
      document
    ) as FrameCandidateScanResult[];

    expect(result).toEqual([{ index: 0, text: "First Name", visible: true }]);
  });

  it("falls back to value for an input[type=submit] with no other accessible-name signal", () => {
    const submit = makeEl("", {
      tagName: "input",
      attributes: { type: "submit", value: "Send Application" },
    });
    const document = makeRoot([submit]);

    const result = evaluateInFakePage(
      buildScanFrameCandidatesExpr("input"),
      document
    ) as FrameCandidateScanResult[];

    expect(result).toEqual([{ index: 0, text: "Send Application", visible: true }]);
  });

  it("prefers aria-label over placeholder/title/textContent when multiple signals are present", () => {
    const input = makeEl("Ignored text", {
      tagName: "input",
      attributes: { "aria-label": "Preferred", placeholder: "Placeholder", title: "Title" },
    });
    const document = makeRoot([input]);

    const result = evaluateInFakePage(
      buildScanFrameCandidatesExpr("input"),
      document
    ) as FrameCandidateScanResult[];

    expect(result).toEqual([{ index: 0, text: "Preferred", visible: true }]);
  });

  it("yields empty text for a structural element with no accessible-name signal at all", () => {
    const div = makeEl("", { tagName: "div" });
    const document = makeRoot([div]);

    const result = evaluateInFakePage(
      buildScanFrameCandidatesExpr("div"),
      document
    ) as FrameCandidateScanResult[];

    expect(result).toEqual([{ index: 0, text: "", visible: true }]);
  });

  it("does not surface concatenated option text as the accessible name for an unlabelled <select>", () => {
    const select = makeEl("Choose oneAlabamaAlaskaArizona", { tagName: "select" });
    const document = makeRoot([select]);

    const result = evaluateInFakePage(
      buildScanFrameCandidatesExpr("select"),
      document
    ) as FrameCandidateScanResult[];

    expect(result).toEqual([{ index: 0, text: "", visible: true }]);
  });

  it("still derives text from aria-label on a <select> whose textContent is concatenated option text", () => {
    const select = makeEl("Choose oneAlabamaAlaskaArizona", {
      tagName: "select",
      attributes: { "aria-label": "State" },
    });
    const document = makeRoot([select]);

    const result = evaluateInFakePage(
      buildScanFrameCandidatesExpr("select"),
      document
    ) as FrameCandidateScanResult[];

    expect(result).toEqual([{ index: 0, text: "State", visible: true }]);
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
