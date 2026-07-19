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
 * `querySelectorAll`, `shadowRoot`, `focus`, `dispatchEvent`). Mirrors the
 * fixture in `deep-query.test.ts` so both modules exercise the real
 * generated expression strings against a hand-built tree rather than a
 * re-implementation of the traversal.
 */
interface FakeEl {
  tagName: string;
  attrs: Record<string, string>;
  textContent: string;
  children: FakeEl[];
  shadowRoot: FakeRoot | null;
  clicked: boolean;
  focused: boolean;
  getAttribute(name: string): string | null;
  querySelectorAll(selector: "*"): FakeEl[];
  focus(): void;
  dispatchEvent(evt: { type: string }): void;
}

interface FakeRoot {
  querySelectorAll(selector: "*"): FakeEl[];
}

function makeEl(tagName: string, attrs: Record<string, string> = {}, textContent = ""): FakeEl {
  const el: FakeEl = {
    tagName: tagName.toUpperCase(),
    attrs,
    textContent,
    children: [],
    shadowRoot: null,
    clicked: false,
    focused: false,
    getAttribute(name) {
      return Object.hasOwn(attrs, name) ? (attrs[name] ?? null) : null;
    },
    querySelectorAll() {
      return flattenDescendants(el.children);
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
 * as global `document`, plus a minimal `Event` constructor (the generated
 * click code only reads `.type` off it).
 */
function evaluateInFakePage(expr: string, document: FakeRoot): unknown {
  return runInNewContext(expr, {
    document,
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
  // the top pick. flow-runner.ts's deep-submit-locator branch does not
  // currently call this with anything but ranked[0] — there is no runner-up
  // retry wired up today — so this pins the module's capability for a future
  // caller rather than exercising an existing retry path.
  it("can click a lower-ranked candidate by deepIndex, independent of tier order (module contract; not currently exercised by any caller)", () => {
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
});

// Regression coverage: append-order sanity so `appendChild` stays exercised
// (mirrors deep-query.test.ts's fixture shape) even though most cases above
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
