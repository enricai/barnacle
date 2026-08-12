import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

import {
  type FakeDomRoot,
  makeFakeDomElement,
  makeSelectorAwareDomRoot,
} from "@/scraper/deep-locator-fake";
import {
  buildClickFrameCandidateExpr,
  buildFillFrameCandidateExpr,
  buildScanFrameCandidatesExpr,
  buildSelectFrameCandidateExpr,
  type FrameCandidateClickResult,
  type FrameCandidateScanResult,
  type FrameCandidateWriteResult,
  isNodeNotActionableError,
} from "@/scraper/deep-locator-scan";

/** One `<select>` option a {@link FakeEl}'s `options` collection carries. */
interface FakeOption {
  value: string;
  textContent: string;
}

/**
 * Minimal fake DOM element supporting exactly the surface the generated
 * expression touches (`textContent`, `getBoundingClientRect`, `getAttribute`,
 * `closest`, `value`, `options`) plus a `computedStyle` bag the fake global
 * `getComputedStyle` reads from — matches `submit-control.test.ts`'s fixture
 * shape (real generated expression string against a hand-built tree, not a
 * re-implementation of the traversal).
 */
interface FakeEl {
  textContent: string;
  rect: { width: number; height: number };
  computedStyle: { display: string; visibility: string };
  tagName: string;
  attributes: Record<string, string>;
  parent: FakeEl | null;
  focused: boolean;
  dispatchedEvents: string[];
  value: string;
  options: FakeOption[];
  getBoundingClientRect(): { width: number; height: number };
  getAttribute(name: string): string | null;
  closest(selector: string): FakeEl | null;
  focus(): void;
  dispatchEvent(evt: { type: string }): void;
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
    value: string;
    options: FakeOption[];
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
    focused: false,
    dispatchedEvents: [],
    value: overrides.value ?? "",
    options: overrides.options ?? [],
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
    focus() {
      el.focused = true;
    },
    dispatchEvent(evt) {
      el.dispatchedEvents.push(evt.type);
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
 * this same registry, matching how a real DOM has one tree underneath every
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
 * Fake native form-element prototype carrying only a `value` accessor whose
 * setter assigns straight onto the element it's `.call`-bound to — this is
 * what a REAL native value-setter (`Object.getOwnPropertyDescriptor(
 * HTMLInputElement.prototype, "value").set`) does when reached via
 * `descriptor.set.call(el, v)`: the assignment lands on `el` itself (a
 * normal own `value` property here, the underlying DOM slot for real),
 * exactly what a subsequent bare `el.value` read in the generated
 * expression observes.
 */
function fakeNativeElementCtor(): { prototype: object } {
  const ctor = { prototype: {} };
  Object.defineProperty(ctor.prototype, "value", {
    set(this: FakeEl, v: string) {
      this.value = v;
    },
  });
  return ctor;
}

/** The three fake globals every generated fill/select expression's native-setter branch resolves against. */
function nativeElementGlobals(): Record<string, unknown> {
  return {
    HTMLInputElement: fakeNativeElementCtor(),
    HTMLTextAreaElement: fakeNativeElementCtor(),
    HTMLSelectElement: fakeNativeElementCtor(),
  };
}

/**
 * Executes a generated expression string against a fake `document` bound as
 * global `document`, plus a fake `getComputedStyle` that reads each fake
 * element's own `computedStyle` bag, and the fake native form-element
 * prototypes the fill/select expressions' native-setter branch resolves
 * against.
 */
function evaluateInFakePage(expr: string, document: FakeRoot): unknown {
  return runInNewContext(expr, {
    document,
    getComputedStyle: (el: FakeEl) => el.computedStyle,
    Event: class {
      type: string;
      constructor(type: string) {
        this.type = type;
      }
    },
    console,
    ...nativeElementGlobals(),
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
    Event: class {
      type: string;
      constructor(type: string) {
        this.type = type;
      }
    },
    console,
    ...nativeElementGlobals(),
  });
}

/**
 * Trivial stand-ins for the real DOM's `HTMLInputElement`/
 * `HTMLTextAreaElement`/`HTMLSelectElement` globals `buildFillFrameCandidateExpr`/
 * `buildSelectFrameCandidateExpr` reference: an empty prototype means
 * `Object.getOwnPropertyDescriptor(...prototype, "value")` resolves to
 * `undefined`, so the generated expression falls back to a bare
 * `el.value = value` assignment against {@link makeFakeDomElement}'s plain
 * writable `value` property — proving the fallback path works when no
 * descriptor is present, same as an unmanaged (non-React) form control.
 */
function fakeNativeElementClasses(): Record<string, unknown> {
  return {
    HTMLInputElement: class {},
    HTMLTextAreaElement: class {},
    HTMLSelectElement: class {},
  };
}

/**
 * Executes a generated write expression string ({@link buildFillFrameCandidateExpr}/
 * {@link buildSelectFrameCandidateExpr}) against a {@link makeSelectorAwareDomRoot}-built
 * fake root, supplying the fake `HTMLInputElement`/`HTMLTextAreaElement`/
 * `HTMLSelectElement` globals (see {@link fakeNativeElementClasses}) the write
 * expression's descriptor lookup references, plus `Event`. `extraGlobals`
 * lets a test override one of the native-element stand-ins with one carrying
 * a real `value` accessor descriptor, to prove the write goes through
 * `descriptor.set` rather than skipping straight to a bare assignment.
 */
function evaluateWriteInFakePage(
  expr: string,
  document: FakeDomRoot,
  extraGlobals: Record<string, unknown> = {}
): unknown {
  return runInNewContext(expr, {
    document,
    getComputedStyle: (el: { computedStyle: { display: string; visibility: string } }) =>
      el.computedStyle,
    Event: class {
      type: string;
      constructor(type: string) {
        this.type = type;
      }
    },
    ...fakeNativeElementClasses(),
    ...extraGlobals,
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

  it("derives text from an associated label[for=id] for a <select>, not its concatenated option text", () => {
    const select = makeEl("United StatesCanadaMexico", {
      tagName: "select",
      attributes: { id: "country" },
    });
    const label = makeEl("Country", { tagName: "label", attributes: { for: "country" } });
    const document = makeRoot([select, label]);

    const result = evaluateInFakePage(
      buildScanFrameCandidatesExpr("select"),
      document
    ) as FrameCandidateScanResult[];

    expect(result).toEqual([{ index: 0, text: "Country", visible: true }]);
  });

  it("yields empty text for an unlabelled <select>, never falling back to its concatenated option text", () => {
    const select = makeEl("United StatesCanadaMexico", { tagName: "select" });
    const document = makeRoot([select]);

    const result = evaluateInFakePage(
      buildScanFrameCandidatesExpr("select"),
      document
    ) as FrameCandidateScanResult[];

    expect(result).toEqual([{ index: 0, text: "", visible: true }]);
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

describe("deep-locator-scan/buildClickFrameCandidateExpr", () => {
  it("clicks exactly the element at querySelectorAll(innerSelector)[index], not a sibling", () => {
    const first = makeEl("First");
    const second = makeEl("Second");
    const third = makeEl("Third");
    const document = makeRoot([first, second, third]);

    const result = evaluateInFakePage(
      buildClickFrameCandidateExpr("button", 1),
      document
    ) as FrameCandidateClickResult;

    expect(result).toEqual({ clicked: true });
    expect(second.focused).toBe(true);
    expect(second.dispatchedEvents).toEqual(["mousedown", "mouseup", "click"]);
    expect(first.dispatchedEvents).toEqual([]);
    expect(third.dispatchedEvents).toEqual([]);
  });

  it('returns {clicked:false, reason:"not-actionable"} for a 0x0 element instead of throwing', () => {
    const zeroSize = makeEl("Hidden", { rect: { width: 0, height: 0 } });
    const document = makeRoot([zeroSize]);

    expect(() => {
      const result = evaluateInFakePage(
        buildClickFrameCandidateExpr("button", 0),
        document
      ) as FrameCandidateClickResult;
      expect(result).toEqual({ clicked: false, reason: "not-actionable" });
    }).not.toThrow();
    expect(zeroSize.dispatchedEvents).toEqual([]);
  });

  it('returns {clicked:false, reason:"not-actionable"} for a display:none element instead of throwing', () => {
    const displayNone = makeEl("Hidden", {
      computedStyle: { display: "none", visibility: "visible" },
    });
    const document = makeRoot([displayNone]);

    const result = evaluateInFakePage(
      buildClickFrameCandidateExpr("button", 0),
      document
    ) as FrameCandidateClickResult;

    expect(result).toEqual({ clicked: false, reason: "not-actionable" });
    expect(displayNone.dispatchedEvents).toEqual([]);
  });

  it('returns {clicked:false, reason:"not-actionable"} for a visibility:hidden element instead of throwing', () => {
    const visibilityHidden = makeEl("Hidden", {
      computedStyle: { display: "block", visibility: "hidden" },
    });
    const document = makeRoot([visibilityHidden]);

    const result = evaluateInFakePage(
      buildClickFrameCandidateExpr("button", 0),
      document
    ) as FrameCandidateClickResult;

    expect(result).toEqual({ clicked: false, reason: "not-actionable" });
    expect(visibilityHidden.dispatchedEvents).toEqual([]);
  });

  it('returns {clicked:false, reason:"out-of-range"} when the index no longer matches', () => {
    const document = makeRoot([makeEl("First")]);

    expect(() => {
      const result = evaluateInFakePage(
        buildClickFrameCandidateExpr("button", 5),
        document
      ) as FrameCandidateClickResult;
      expect(result).toEqual({ clicked: false, reason: "out-of-range" });
    }).not.toThrow();
  });

  it("distinguishes out-of-range from not-actionable for the same missing/unrendered index", () => {
    const document = makeRoot([]);

    const result = evaluateInFakePage(
      buildClickFrameCandidateExpr("button", 0),
      document
    ) as FrameCandidateClickResult;

    expect(result.reason).toBe("out-of-range");
    expect(result.reason).not.toBe("not-actionable");
  });

  it("resolves against the injected root realm via the root arg, never an outer document", () => {
    const outerButton = makeEl("Outer");
    const outerDocument = makeRoot([outerButton]);
    const frameButton = makeEl("Inner");
    const frameDocument = makeRoot([frameButton]);

    const result = evaluateInFakeFrame(
      buildClickFrameCandidateExpr("button", 0, "document"),
      frameDocument,
      outerDocument
    ) as FrameCandidateClickResult;

    expect(result).toEqual({ clicked: true });
    expect(frameButton.dispatchedEvents).toEqual(["mousedown", "mouseup", "click"]);
    expect(outerButton.dispatchedEvents).toEqual([]);
  });

  it("defaults to `document`, resolved from the executing realm (no root arg passed)", () => {
    const outerButton = makeEl("Outer");
    const outerDocument = makeRoot([outerButton]);
    const frameButton = makeEl("Inner");
    const frameDocument = makeRoot([frameButton]);

    const result = evaluateInFakeFrame(
      buildClickFrameCandidateExpr("button", 0),
      frameDocument,
      outerDocument
    ) as FrameCandidateClickResult;

    expect(result).toEqual({ clicked: true });
    expect(frameButton.dispatchedEvents).toEqual(["mousedown", "mouseup", "click"]);
    expect(outerButton.dispatchedEvents).toEqual([]);
  });
});

describe("deep-locator-scan/buildFillFrameCandidateExpr", () => {
  it("fills the <input> at querySelectorAll(innerSelector)[index], dispatches input/change/blur, and returns {written:true, readBack}", () => {
    const input = makeFakeDomElement("", { tagName: "input", value: "" });
    const root = makeSelectorAwareDomRoot([input]);

    const result = evaluateWriteInFakePage(
      buildFillFrameCandidateExpr("input", 0, "Ada"),
      root
    ) as FrameCandidateWriteResult;

    expect(result).toEqual({ written: true, readBack: "Ada" });
    expect(input.value).toBe("Ada");
    expect(input.dispatchedEvents).toEqual(["input", "change", "blur"]);
  });

  it("fills a <textarea> the same way as an <input>, resolving its own native-class descriptor lookup", () => {
    const textarea = makeFakeDomElement("", { tagName: "textarea", value: "" });
    const root = makeSelectorAwareDomRoot([textarea]);

    const result = evaluateWriteInFakePage(
      buildFillFrameCandidateExpr("textarea", 0, "Cover letter text"),
      root
    ) as FrameCandidateWriteResult;

    expect(result).toEqual({ written: true, readBack: "Cover letter text" });
    expect(textarea.value).toBe("Cover letter text");
    expect(textarea.dispatchedEvents).toEqual(["input", "change", "blur"]);
  });

  it('returns {written:false, reason:"out-of-range"} when the index no longer matches, without throwing', () => {
    const input = makeFakeDomElement("", { tagName: "input", value: "" });
    const root = makeSelectorAwareDomRoot([input]);

    expect(() => {
      const result = evaluateWriteInFakePage(
        buildFillFrameCandidateExpr("input", 5, "Ada"),
        root
      ) as FrameCandidateWriteResult;
      expect(result).toEqual({ written: false, reason: "out-of-range" });
    }).not.toThrow();
    expect(input.value).toBe("");
    expect(input.dispatchedEvents).toEqual([]);
  });

  it('returns {written:false, reason:"not-actionable"} for a 0x0 element without writing or dispatching anything', () => {
    const input = makeFakeDomElement("", {
      tagName: "input",
      rect: { width: 0, height: 0 },
      value: "",
    });
    const root = makeSelectorAwareDomRoot([input]);

    const result = evaluateWriteInFakePage(
      buildFillFrameCandidateExpr("input", 0, "Ada"),
      root
    ) as FrameCandidateWriteResult;

    expect(result).toEqual({ written: false, reason: "not-actionable" });
    expect(input.value).toBe("");
    expect(input.dispatchedEvents).toEqual([]);
  });

  it('returns {written:false, reason:"not-actionable"} for a display:none element without writing or dispatching anything', () => {
    const input = makeFakeDomElement("", {
      tagName: "input",
      computedStyle: { display: "none", visibility: "visible" },
      value: "",
    });
    const root = makeSelectorAwareDomRoot([input]);

    const result = evaluateWriteInFakePage(
      buildFillFrameCandidateExpr("input", 0, "Ada"),
      root
    ) as FrameCandidateWriteResult;

    expect(result).toEqual({ written: false, reason: "not-actionable" });
    expect(input.value).toBe("");
    expect(input.dispatchedEvents).toEqual([]);
  });

  it("resolves against the injected root realm via the root arg, never an outer document", () => {
    const outerInput = makeFakeDomElement("", { tagName: "input", value: "" });
    const outerRoot = makeSelectorAwareDomRoot([outerInput]);
    const innerInput = makeFakeDomElement("", { tagName: "input", value: "" });
    const innerRoot = makeSelectorAwareDomRoot([innerInput]);

    const result = evaluateWriteInFakePage(
      buildFillFrameCandidateExpr("input", 0, "Ada", "document"),
      innerRoot,
      { __outerDocumentNeverReferenced: outerRoot }
    ) as FrameCandidateWriteResult;

    expect(result).toEqual({ written: true, readBack: "Ada" });
    expect(innerInput.value).toBe("Ada");
    expect(outerInput.value).toBe("");
  });

  it("defaults to `document`, resolved from the executing realm (no root arg passed)", () => {
    const outerInput = makeFakeDomElement("", { tagName: "input", value: "" });
    const outerRoot = makeSelectorAwareDomRoot([outerInput]);
    const innerInput = makeFakeDomElement("", { tagName: "input", value: "" });
    const innerRoot = makeSelectorAwareDomRoot([innerInput]);

    const result = evaluateWriteInFakePage(
      buildFillFrameCandidateExpr("input", 0, "Ada"),
      innerRoot,
      { __outerDocumentNeverReferenced: outerRoot }
    ) as FrameCandidateWriteResult;

    expect(result).toEqual({ written: true, readBack: "Ada" });
    expect(innerInput.value).toBe("Ada");
    expect(outerInput.value).toBe("");
  });

  it("routes the write through a value descriptor's setter on the native element class when one is present, instead of silently skipping it", () => {
    const setCalls: string[] = [];
    class NativeInputWithTrackedSetter {}
    Object.defineProperty(NativeInputWithTrackedSetter.prototype, "value", {
      get() {
        return (this as { value: string }).value;
      },
      set(v: string) {
        setCalls.push(v);
        (this as { value: string }).value = v;
      },
    });
    const input = makeFakeDomElement("", { tagName: "input", value: "" });
    const root = makeSelectorAwareDomRoot([input]);

    const result = evaluateWriteInFakePage(buildFillFrameCandidateExpr("input", 0, "Ada"), root, {
      HTMLInputElement: NativeInputWithTrackedSetter,
    }) as FrameCandidateWriteResult;

    expect(setCalls).toEqual(["Ada"]);
    expect(result).toEqual({ written: true, readBack: "Ada" });
  });

  it("contains no bare `document` reference outside the interpolated root", () => {
    const expr = buildFillFrameCandidateExpr("input", 0, "Ada", "myFrameRoot");

    expect(expr).not.toMatch(/\bdocument\b/);
  });
});

describe("deep-locator-scan/buildSelectFrameCandidateExpr", () => {
  it("matches an option by value, dispatches input/change/blur, and reports the matched value as readBack", () => {
    const select = makeFakeDomElement("", {
      tagName: "select",
      value: "",
      options: [
        { value: "us", textContent: "United States" },
        { value: "ca", textContent: "Canada" },
      ],
    });
    const root = makeSelectorAwareDomRoot([select]);

    const result = evaluateWriteInFakePage(
      buildSelectFrameCandidateExpr("select", 0, "ca"),
      root
    ) as FrameCandidateWriteResult;

    expect(result).toEqual({ written: true, readBack: "ca" });
    expect(select.value).toBe("ca");
    expect(select.dispatchedEvents).toEqual(["input", "change", "blur"]);
  });

  it("falls back to a trimmed option-label match when no option value equals the requested value", () => {
    const select = makeFakeDomElement("", {
      tagName: "select",
      value: "",
      options: [
        { value: "us", textContent: " United States " },
        { value: "ca", textContent: "Canada" },
      ],
    });
    const root = makeSelectorAwareDomRoot([select]);

    const result = evaluateWriteInFakePage(
      buildSelectFrameCandidateExpr("select", 0, "United States"),
      root
    ) as FrameCandidateWriteResult;

    expect(result).toEqual({ written: true, readBack: "us" });
    expect(select.value).toBe("us");
  });

  it("prefers a value match over a label match when both are present on different options", () => {
    const select = makeFakeDomElement("", {
      tagName: "select",
      value: "",
      options: [
        { value: "Canada", textContent: "Other" },
        { value: "ca", textContent: "Canada" },
      ],
    });
    const root = makeSelectorAwareDomRoot([select]);

    const result = evaluateWriteInFakePage(
      buildSelectFrameCandidateExpr("select", 0, "Canada"),
      root
    ) as FrameCandidateWriteResult;

    expect(result).toEqual({ written: true, readBack: "Canada" });
  });

  it('returns {written:false, reason:"not-actionable"} when no option matches by value or label, without throwing', () => {
    const select = makeFakeDomElement("", {
      tagName: "select",
      value: "",
      options: [{ value: "us", textContent: "United States" }],
    });
    const root = makeSelectorAwareDomRoot([select]);

    const result = evaluateWriteInFakePage(
      buildSelectFrameCandidateExpr("select", 0, "Mexico"),
      root
    ) as FrameCandidateWriteResult;

    expect(result).toEqual({ written: false, reason: "not-actionable" });
    expect(select.value).toBe("");
    expect(select.dispatchedEvents).toEqual([]);
  });

  it('returns {written:false, reason:"out-of-range"} when the index no longer matches, without throwing', () => {
    const select = makeFakeDomElement("", { tagName: "select", value: "" });
    const root = makeSelectorAwareDomRoot([select]);

    expect(() => {
      const result = evaluateWriteInFakePage(
        buildSelectFrameCandidateExpr("select", 3, "us"),
        root
      ) as FrameCandidateWriteResult;
      expect(result).toEqual({ written: false, reason: "out-of-range" });
    }).not.toThrow();
    expect(select.value).toBe("");
    expect(select.dispatchedEvents).toEqual([]);
  });

  it('returns {written:false, reason:"not-actionable"} for an unrendered <select> without writing or dispatching anything', () => {
    const select = makeFakeDomElement("", {
      tagName: "select",
      rect: { width: 0, height: 0 },
      value: "",
      options: [{ value: "us", textContent: "United States" }],
    });
    const root = makeSelectorAwareDomRoot([select]);

    const result = evaluateWriteInFakePage(
      buildSelectFrameCandidateExpr("select", 0, "us"),
      root
    ) as FrameCandidateWriteResult;

    expect(result).toEqual({ written: false, reason: "not-actionable" });
    expect(select.value).toBe("");
    expect(select.dispatchedEvents).toEqual([]);
  });

  it("resolves against the injected root realm via the root arg, never an outer document", () => {
    const outerSelect = makeFakeDomElement("", {
      tagName: "select",
      value: "",
      options: [{ value: "outer", textContent: "Outer" }],
    });
    const outerRoot = makeSelectorAwareDomRoot([outerSelect]);
    const innerSelect = makeFakeDomElement("", {
      tagName: "select",
      value: "",
      options: [{ value: "us", textContent: "United States" }],
    });
    const innerRoot = makeSelectorAwareDomRoot([innerSelect]);

    const result = evaluateWriteInFakePage(
      buildSelectFrameCandidateExpr("select", 0, "us", "document"),
      innerRoot,
      { __outerDocumentNeverReferenced: outerRoot }
    ) as FrameCandidateWriteResult;

    expect(result).toEqual({ written: true, readBack: "us" });
    expect(innerSelect.value).toBe("us");
    expect(outerSelect.value).toBe("");
  });

  it("routes the write through a value descriptor's setter on HTMLSelectElement when one is present, instead of silently skipping it", () => {
    const setCalls: string[] = [];
    class NativeSelectWithTrackedSetter {}
    Object.defineProperty(NativeSelectWithTrackedSetter.prototype, "value", {
      get() {
        return (this as { value: string }).value;
      },
      set(v: string) {
        setCalls.push(v);
        (this as { value: string }).value = v;
      },
    });
    const select = makeFakeDomElement("", {
      tagName: "select",
      value: "",
      options: [{ value: "us", textContent: "United States" }],
    });
    const root = makeSelectorAwareDomRoot([select]);

    const result = evaluateWriteInFakePage(buildSelectFrameCandidateExpr("select", 0, "us"), root, {
      HTMLSelectElement: NativeSelectWithTrackedSetter,
    }) as FrameCandidateWriteResult;

    expect(setCalls).toEqual(["us"]);
    expect(result).toEqual({ written: true, readBack: "us" });
  });

  it("contains no bare `document` reference outside the interpolated root", () => {
    const expr = buildSelectFrameCandidateExpr("select", 0, "us", "myFrameRoot");

    expect(expr).not.toMatch(/\bdocument\b/);
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
