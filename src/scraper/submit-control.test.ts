import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

import {
  buildClickByDeepIndexExpr,
  buildRankSubmitCandidatesExpr,
  type SubmitCandidate,
} from "@/scraper/submit-control";

/**
 * Minimal fake DOM element supporting exactly the surface the generated
 * expressions touch (`tagName`, `getAttribute`, `textContent`,
 * `querySelectorAll`, `shadowRoot`, `focus`, `dispatchEvent`,
 * `getBoundingClientRect`) plus a `computedStyle` bag the fake global
 * `getComputedStyle` reads from. Matches the fixture in `deep-query.test.ts`
 * and `deep-locator-scan.test.ts`'s visibility shape so all three modules
 * exercise the real generated expression strings against a hand-built tree
 * rather than a re-implementation of the traversal.
 */
interface FakeEl {
  tagName: string;
  attrs: Record<string, string>;
  textContent: string;
  children: FakeEl[];
  shadowRoot: FakeRoot | null;
  rect: { width: number; height: number };
  computedStyle: { display: string; visibility: string };
  clicked: boolean;
  focused: boolean;
  getAttribute(name: string): string | null;
  querySelectorAll(selector: "*"): FakeEl[];
  getBoundingClientRect(): { width: number; height: number };
  focus(): void;
  dispatchEvent(evt: { type: string }): void;
}

interface FakeRoot {
  querySelectorAll(selector: "*"): FakeEl[];
}

function makeEl(
  tagName: string,
  attrs: Record<string, string> = {},
  textContent = "",
  overrides: Partial<{
    rect: { width: number; height: number };
    computedStyle: { display: string; visibility: string };
  }> = {}
): FakeEl {
  const rect = overrides.rect ?? { width: 100, height: 20 };
  const computedStyle = overrides.computedStyle ?? { display: "block", visibility: "visible" };
  const el: FakeEl = {
    tagName: tagName.toUpperCase(),
    attrs,
    textContent,
    children: [],
    shadowRoot: null,
    rect,
    computedStyle,
    clicked: false,
    focused: false,
    getAttribute(name) {
      return Object.hasOwn(attrs, name) ? (attrs[name] ?? null) : null;
    },
    querySelectorAll() {
      return flattenDescendants(el.children);
    },
    getBoundingClientRect() {
      return rect;
    },
    focus() {
      el.focused = true;
    },
    dispatchEvent(evt) {
      if (evt.type === "click") el.clicked = true;
    },
  };
  return el;
}

function flattenDescendants(children: FakeEl[]): FakeEl[] {
  const out: FakeEl[] = [];
  for (const child of children) {
    out.push(child);
    out.push(...flattenDescendants(child.children));
  }
  return out;
}

function appendChild(parent: FakeEl, child: FakeEl): FakeEl {
  parent.children.push(child);
  return child;
}

function makeRoot(topLevel: FakeEl[]): FakeRoot {
  return {
    querySelectorAll() {
      return flattenDescendants(topLevel);
    },
  };
}

/**
 * Executes a generated expression string against a fake `document` bound
 * as global `document`, plus a fake `getComputedStyle` that reads each fake
 * element's own `computedStyle` bag, and a minimal `Event` constructor (the
 * generated click code only reads `.type` off it).
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
  });
}

/**
 * Executes a generated expression string with `frameDocument` bound as
 * global `document` and the outer page's own fake root bound under a
 * different global name, simulating what `Frame.evaluate` does for real:
 * `document` resolves to the executing frame's document, never to some
 * outer captured reference. If a builder ever referenced an outer
 * `document` instead of the supplied `root`, this fixture would surface
 * it by finding the outer page's elements instead of the frame's.
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
  });
}

describe("submit-control/buildRankSubmitCandidatesExpr", () => {
  it('ranks a type="submit" element inside a shadow root above weaker matches', () => {
    const shadowSubmit = makeEl("button", { type: "submit" }, "Continue");
    const shadowRoot = makeRoot([shadowSubmit]);
    const host = makeEl("app-form-actions");
    host.shadowRoot = shadowRoot;

    const angularStyle = makeEl("div", { role: "button" }, "Submit Application");

    const document = makeRoot([host, angularStyle]);

    const result = evaluateInFakePage(
      buildRankSubmitCandidatesExpr(),
      document
    ) as SubmitCandidate[];

    expect(result.length).toBeGreaterThanOrEqual(2);
    expect(result[0]?.tier).toBe(3);
    expect(result[0]?.tag).toBe("button");
    expect(result.some((c) => c.tier === 1 && c.accessibleName === "submit application")).toBe(
      true
    );
  });

  it("ranks a shadow-root button whose accessible text is exactly 'Submit' as tier 2", () => {
    const shadowButton = makeEl("button", {}, "Submit");
    const shadowRoot = makeRoot([shadowButton]);
    const host = makeEl("app-submit-button");
    host.shadowRoot = shadowRoot;
    const document = makeRoot([host]);

    const result = evaluateInFakePage(
      buildRankSubmitCandidatesExpr(),
      document
    ) as SubmitCandidate[];

    expect(result).toHaveLength(1);
    expect(result[0]?.tier).toBe(2);
    expect(result[0]?.accessibleName).toBe("submit");
  });

  it("matches an Angular-style control by role+text with no type attribute (tier 1)", () => {
    const control = makeEl("div", { role: "button", "aria-label": "Submit Application" });
    const document = makeRoot([control]);

    const result = evaluateInFakePage(
      buildRankSubmitCandidatesExpr(),
      document
    ) as SubmitCandidate[];

    expect(result).toHaveLength(1);
    expect(result[0]?.tier).toBe(1);
    expect(result[0]?.accessibleName).toBe("submit application");
  });

  it("returns no candidates on a page whose only button is 'Back' (no false positive)", () => {
    const back = makeEl("button", {}, "Back");
    const cancel = makeEl("button", {}, "Cancel");
    const saveDraft = makeEl("button", { role: "button" }, "Save Draft");
    const document = makeRoot([back, cancel, saveDraft]);

    const result = evaluateInFakePage(
      buildRankSubmitCandidatesExpr(),
      document
    ) as SubmitCandidate[];

    expect(result).toEqual([]);
  });

  it('excludes a type="submit" button whose only text is a negative verb', () => {
    // Defends against a plain <button type="submit">Cancel</button> misconfiguration
    // still being preferred over a real submit control elsewhere on the page.
    const mislabeled = makeEl("button", { type: "submit" }, "Cancel");
    const document = makeRoot([mislabeled]);

    const result = evaluateInFakePage(
      buildRankSubmitCandidatesExpr(),
      document
    ) as SubmitCandidate[];

    expect(result).toEqual([]);
  });

  it("orders multiple same-tier candidates by document order", () => {
    const first = makeEl("button", { type: "submit" }, "Submit");
    const second = makeEl("input", { type: "submit" }, "");
    const document = makeRoot([first, second]);

    const result = evaluateInFakePage(
      buildRankSubmitCandidatesExpr(),
      document
    ) as SubmitCandidate[];

    expect(result).toHaveLength(2);
    expect(result[0]?.deepIndex).toBeLessThan(result[1]?.deepIndex as number);
  });

  it("orders three same-tier candidates in strict ascending deepIndex order", () => {
    const first = makeEl("button", { type: "submit" }, "Submit");
    const second = makeEl("input", { type: "submit" }, "");
    const third = makeEl("button", { type: "submit" }, "Submit");
    const document = makeRoot([first, second, third]);

    const result = evaluateInFakePage(
      buildRankSubmitCandidatesExpr(),
      document
    ) as SubmitCandidate[];

    expect(result).toHaveLength(3);
    expect(result.every((c) => c.tier === 3)).toBe(true);
    expect(result.map((c) => c.deepIndex)).toEqual(
      [...result.map((c) => c.deepIndex)].sort((a, b) => a - b)
    );
  });

  it("orders mixed-tier candidates strictly by (tier desc, deepIndex asc), independent of sort stability", () => {
    // Deliberately interleaves tiers out of order so a comparator that only
    // compares `tier` (relying on Array.prototype.sort's stability to keep
    // intra-tier document order) cannot pass this by accident: entries are
    // pre-shuffled relative to their eventual rank.
    const tier1First = makeEl("div", { role: "button" }, "Submit Application");
    const tier3First = makeEl("button", { type: "submit" }, "Submit");
    const tier2First = makeEl("button", {}, "Submit");
    const tier1Second = makeEl("div", { role: "button" }, "Please Submit Now");
    const tier3Second = makeEl("input", { type: "submit" }, "");
    const document = makeRoot([tier1First, tier3First, tier2First, tier1Second, tier3Second]);

    const result = evaluateInFakePage(
      buildRankSubmitCandidatesExpr(),
      document
    ) as SubmitCandidate[];

    expect(result).toHaveLength(5);
    expect(result.map((c) => c.tier)).toEqual([3, 3, 2, 1, 1]);
    result.forEach((candidate, i) => {
      const next = result[i + 1];
      if (!next) return;
      const strictlyOrdered =
        candidate.tier > next.tier ||
        (candidate.tier === next.tier && candidate.deepIndex < next.deepIndex);
      expect(strictlyOrdered).toBe(true);
    });
  });

  it('ranks an <input type="submit"> as tier 3, same as a type="submit" button', () => {
    const input = makeEl("input", { type: "submit" }, "");
    const document = makeRoot([input]);

    const result = evaluateInFakePage(
      buildRankSubmitCandidatesExpr(),
      document
    ) as SubmitCandidate[];

    expect(result).toHaveLength(1);
    expect(result[0]?.tier).toBe(3);
    expect(result[0]?.tag).toBe("input");
  });

  it("excludes a non-button-like element (no button/input tag, no role) carrying submit-shaped text", () => {
    const div = makeEl("div", {}, "Submit Application");
    const document = makeRoot([div]);

    const result = evaluateInFakePage(
      buildRankSubmitCandidatesExpr(),
      document
    ) as SubmitCandidate[];

    expect(result).toEqual([]);
  });

  it("prefers aria-label over conflicting textContent for the accessible name", () => {
    const control = makeEl("button", { role: "button", "aria-label": "Submit" }, "Cancel");
    const document = makeRoot([control]);

    const result = evaluateInFakePage(
      buildRankSubmitCandidatesExpr(),
      document
    ) as SubmitCandidate[];

    expect(result).toHaveLength(1);
    expect(result[0]?.tier).toBe(2);
    expect(result[0]?.accessibleName).toBe("submit");
  });

  it("defaults to `document`, resolved from the executing realm (no root arg passed)", () => {
    const outerButton = makeEl("button", { type: "submit" }, "Outer Submit");
    const outerDocument = makeRoot([outerButton]);
    const frameButton = makeEl("button", { type: "submit" }, "Submit");
    const frameDocument = makeRoot([frameButton]);

    const result = evaluateInFakeFrame(
      buildRankSubmitCandidatesExpr(),
      frameDocument,
      outerDocument
    ) as SubmitCandidate[];

    expect(result).toHaveLength(1);
    expect(result[0]?.tag).toBe("button");
    expect(result[0]?.accessibleName).toBe("submit");
  });

  it('excludes a type="submit" button with a 0x0 rect (hidden wizard step) while ranking a rendered sibling normally', () => {
    const hiddenStepSubmit = makeEl("button", { type: "submit" }, "Submit", {
      rect: { width: 0, height: 0 },
    });
    const renderedSubmit = makeEl("button", { type: "submit" }, "Submit");
    const document = makeRoot([hiddenStepSubmit, renderedSubmit]);

    const result = evaluateInFakePage(
      buildRankSubmitCandidatesExpr(),
      document
    ) as SubmitCandidate[];

    expect(result).toHaveLength(1);
    expect(result[0]?.tier).toBe(3);
    expect(result[0]?.deepIndex).toBe(1);
  });

  it('excludes a type="submit" button with computed display:none while ranking a rendered sibling normally', () => {
    const hiddenStepSubmit = makeEl("button", { type: "submit" }, "Submit", {
      computedStyle: { display: "none", visibility: "visible" },
    });
    const renderedSubmit = makeEl("button", { type: "submit" }, "Submit");
    const document = makeRoot([hiddenStepSubmit, renderedSubmit]);

    const result = evaluateInFakePage(
      buildRankSubmitCandidatesExpr(),
      document
    ) as SubmitCandidate[];

    expect(result).toHaveLength(1);
    expect(result[0]?.tier).toBe(3);
    expect(result[0]?.deepIndex).toBe(1);
  });

  it("does not shift a later candidate's deepIndex when an earlier candidate is excluded for being unrendered", () => {
    const hiddenStepSubmit = makeEl("button", { type: "submit" }, "Submit", {
      rect: { width: 0, height: 0 },
    });
    const decoy = makeEl("div", {}, "Not a candidate");
    const renderedSubmit = makeEl("button", { type: "submit" }, "Submit");
    const document = makeRoot([hiddenStepSubmit, decoy, renderedSubmit]);

    const result = evaluateInFakePage(
      buildRankSubmitCandidatesExpr(),
      document
    ) as SubmitCandidate[];

    expect(result).toHaveLength(1);
    // deepIndex is a position in the full deep-traversal order (hiddenStepSubmit=0,
    // decoy=1, renderedSubmit=2), not in the filtered/ranked array, so excluding the
    // hidden candidate must NOT renumber renderedSubmit down to 1.
    expect(result[0]?.deepIndex).toBe(2);
  });

  it("ranks candidates rooted in a frame-document-like tree via the root arg, ignoring the outer document", () => {
    const outerButton = makeEl("button", { type: "submit" }, "Outer Submit");
    const outerDocument = makeRoot([outerButton]);

    const frameSubmit = makeEl("button", { type: "submit" }, "Continue");
    const frameShadowRoot = makeRoot([frameSubmit]);
    const frameHost = makeEl("app-form-actions");
    frameHost.shadowRoot = frameShadowRoot;
    const frameDocument = makeRoot([frameHost]);

    const result = evaluateInFakeFrame(
      buildRankSubmitCandidatesExpr("document"),
      frameDocument,
      outerDocument
    ) as SubmitCandidate[];

    expect(result).toHaveLength(1);
    expect(result[0]?.tier).toBe(3);
  });
});

describe("submit-control/buildClickByDeepIndexExpr", () => {
  it("clicks the candidate at the given deep index, nested inside a shadow root", () => {
    const shadowSubmit = makeEl("button", { type: "submit" }, "Submit");
    const shadowRoot = makeRoot([shadowSubmit]);
    const host = makeEl("app-form-actions");
    host.shadowRoot = shadowRoot;
    const document = makeRoot([host]);

    const ranked = evaluateInFakePage(
      buildRankSubmitCandidatesExpr(),
      document
    ) as SubmitCandidate[];
    expect(ranked).toHaveLength(1);

    const clickResult = evaluateInFakePage(
      buildClickByDeepIndexExpr(ranked[0]?.deepIndex as number),
      document
    ) as { clicked: boolean };

    expect(clickResult).toEqual({ clicked: true });
    expect(shadowSubmit.clicked).toBe(true);
  });

  // Module-contract test, not a caller-behavior test: buildClickByDeepIndexExpr
  // can click ANY ranked candidate by its deepIndex, including one that isn't
  // the top pick. flow-runner.ts's deep-submit-locator branch exercises this
  // via its runner-up retry when the top pick phantom-clicks (see
  // flow-runner.test.ts's phantom-click-escalation suite) — this test pins
  // the underlying module primitive directly, independent of that caller.
  it("can click a lower-ranked candidate by deepIndex, independent of tier order (module contract)", () => {
    const topPick = makeEl("button", { type: "submit" }, "Submit");
    const runnerUp = makeEl("div", { role: "button" }, "Submit Application");
    const document = makeRoot([topPick, runnerUp]);

    const ranked = evaluateInFakePage(
      buildRankSubmitCandidatesExpr(),
      document
    ) as SubmitCandidate[];
    expect(ranked).toHaveLength(2);
    expect(ranked[0]?.tier).toBeGreaterThan(ranked[1]?.tier as number);

    evaluateInFakePage(buildClickByDeepIndexExpr(ranked[1]?.deepIndex as number), document);

    expect(runnerUp.clicked).toBe(true);
    expect(topPick.clicked).toBe(false);
  });

  it("degrades to not-clicked (never throws) when the index is out of range", () => {
    const document = makeRoot([makeEl("button", { type: "submit" }, "Submit")]);

    expect(() => {
      const result = evaluateInFakePage(buildClickByDeepIndexExpr(99), document) as {
        clicked: boolean;
      };
      expect(result).toEqual({ clicked: false });
    }).not.toThrow();
  });

  it('returns {clicked:false, reason:"not-actionable"} without dispatching events when the node at deepIndex has no layout box', () => {
    const unrendered = makeEl("button", { type: "submit" }, "Submit", {
      rect: { width: 0, height: 0 },
    });
    const document = makeRoot([unrendered]);

    const result = evaluateInFakePage(buildClickByDeepIndexExpr(0), document) as {
      clicked: boolean;
      reason?: string;
    };

    expect(result).toEqual({ clicked: false, reason: "not-actionable" });
    expect(unrendered.clicked).toBe(false);
    expect(unrendered.focused).toBe(false);
  });

  it('returns {clicked:false, reason:"not-actionable"} for a node with computed display:none', () => {
    const unrendered = makeEl("button", { type: "submit" }, "Submit", {
      computedStyle: { display: "none", visibility: "visible" },
    });
    const document = makeRoot([unrendered]);

    const result = evaluateInFakePage(buildClickByDeepIndexExpr(0), document) as {
      clicked: boolean;
      reason?: string;
    };

    expect(result).toEqual({ clicked: false, reason: "not-actionable" });
    expect(unrendered.clicked).toBe(false);
  });

  it("clicks the candidate in a frame-document-like tree via the root arg, ignoring the outer document", () => {
    const outerButton = makeEl("button", { type: "submit" }, "Outer Submit");
    const outerDocument = makeRoot([outerButton]);

    const frameSubmit = makeEl("button", { type: "submit" }, "Submit");
    const frameDocument = makeRoot([frameSubmit]);

    const ranked = evaluateInFakeFrame(
      buildRankSubmitCandidatesExpr("document"),
      frameDocument,
      outerDocument
    ) as SubmitCandidate[];
    expect(ranked).toHaveLength(1);

    const clickResult = evaluateInFakeFrame(
      buildClickByDeepIndexExpr(ranked[0]?.deepIndex as number, "document"),
      frameDocument,
      outerDocument
    ) as { clicked: boolean };

    expect(clickResult).toEqual({ clicked: true });
    expect(frameSubmit.clicked).toBe(true);
    expect(outerButton.clicked).toBe(false);
  });
});

// Regression coverage: append-order sanity so `appendChild` stays exercised
// (matches deep-query.test.ts's fixture shape) even though most cases above
// build flat trees directly via makeRoot.
describe("submit-control fixture sanity", () => {
  it("flattens nested children via appendChild in document order", () => {
    const form = makeEl("form");
    const submitButton = appendChild(form, makeEl("button", { type: "submit" }, "Submit"));
    const document = makeRoot([form]);

    const result = evaluateInFakePage(
      buildRankSubmitCandidatesExpr(),
      document
    ) as SubmitCandidate[];

    expect(result).toHaveLength(1);
    expect(result[0]?.tier).toBe(3);
    expect(submitButton.getAttribute("type")).toBe("submit");
  });
});
