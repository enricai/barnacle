import type { Action } from "@browserbasehq/stagehand";
import { describe, expect, it, vi } from "vitest";

import { verifyDomEffect } from "@/scraper/flow-runner";
import type { FrameTarget } from "@/scraper/frame-target";

/**
 * Coverage for the ELEMENT-SCOPED selection read-back in `verifyDomEffect`'s
 * click branch: a design-system option/toggle button (Base Web `kind` flip,
 * hashed styletron class swap) exposes no native `checked` and no ARIA, so the
 * verifier compares the RESOLVED element's own committed-state fingerprint
 * against the pre-action baseline. A change on that element = the click
 * registered; no change (or no baseline) = defer to the network/URL signal.
 */

const XPATH = "/html[1]/body[1]/div[1]/div[2]/button[1]";
const SELECTOR = `xpath=${XPATH}`;

type Fingerprint = {
  kind: string;
  cls: string;
  ariaPressed: string;
  ariaChecked: string;
  ariaSelected: string;
  dataState: string;
  dataSelected: string;
  dataChecked: string;
  checked: string;
  value: string;
};

const fp = (over: Partial<Fingerprint>): Fingerprint => ({
  kind: "",
  cls: "",
  ariaPressed: "",
  ariaChecked: "",
  ariaSelected: "",
  dataState: "",
  dataSelected: "",
  dataChecked: "",
  checked: "",
  value: "",
  ...over,
});

/**
 * A FrameTarget whose `evaluate` answers the browser expressions the click
 * branch runs: the `el.type` probe (returns `null` for a plain <button>), the
 * element-fingerprint read (returns `postFingerprint`), and — new — the
 * ancestor-walk expression (returns `ancestorWalkResult`, a raw boolean the
 * helper coerces via `=== true`). `ancestorWalkResult` defaults to `false` so
 * every existing case that expects a leaf-only verdict is unchanged: a leaf
 * whose own fingerprint didn't move now additionally consults the ancestor
 * walk, which returns `false` here unless a case opts in.
 */
function makeTarget(
  postFingerprint: Fingerprint | null,
  ancestorWalkResult: boolean = false
): FrameTarget {
  const evaluate = vi.fn(async (expr: string) => {
    // The ancestor-walk expression is uniquely identified by its SELECTION_ROLES
    // set literal; check it FIRST since it also contains `getAttribute("kind")`.
    if (expr.includes("SELECTION_ROLES")) return ancestorWalkResult;
    // The element-fingerprint expression reads `getAttribute("kind")`; the
    // input-type probe reads `el.type`. Distinguish by a token unique to the
    // fingerprint expr.
    if (expr.includes('getAttribute("kind")')) return postFingerprint;
    return null; // el.type probe → not a radio/checkbox
  });
  return {
    frame: {} as FrameTarget["frame"],
    frameSelector: null,
    evaluate: evaluate as unknown as FrameTarget["evaluate"],
    locator: (() => ({
      first: () => ({
        isChecked: vi.fn().mockResolvedValue(false),
        inputValue: vi.fn().mockResolvedValue(""),
      }),
    })) as unknown as FrameTarget["locator"],
    url: () => Promise.resolve("https://apply.example/onboard/a/4"),
    title: () => Promise.resolve("Onboard"),
  };
}

const clickAction: Action = {
  selector: SELECTOR,
  description: "Acute Care / Inpatient option",
  method: "click",
} as Action;

describe("flow-runner/verifyDomEffect — element-scoped selection read-back", () => {
  it("credits a Base Web kind flip (tertiary→primary) on the clicked element", async () => {
    const pre = { [XPATH]: fp({ kind: "tertiary", cls: "ih-a ih-b" }) };
    const target = makeTarget(fp({ kind: "primary", cls: "ih-a ih-c" }));

    expect(await verifyDomEffect(target, clickAction, pre)).toBe(true);
  });

  it("credits a hashed-class swap even when kind is unchanged", async () => {
    const pre = { [XPATH]: fp({ kind: "tertiary", cls: "ih-a ih-b" }) };
    const target = makeTarget(fp({ kind: "tertiary", cls: "ih-a ih-z" }));

    expect(await verifyDomEffect(target, clickAction, pre)).toBe(true);
  });

  it("credits an ARIA flip on a marker-based toggle", async () => {
    const pre = { [XPATH]: fp({ ariaPressed: "false" }) };
    const target = makeTarget(fp({ ariaPressed: "true" }));

    expect(await verifyDomEffect(target, clickAction, pre)).toBe(true);
  });

  it("does NOT credit when the clicked element's own state is unchanged", async () => {
    const same = fp({ kind: "tertiary", cls: "ih-a ih-b" });
    const pre = { [XPATH]: same };
    const target = makeTarget(fp({ kind: "tertiary", cls: "ih-a ih-b" }));

    expect(await verifyDomEffect(target, clickAction, pre)).toBe(false);
  });

  it("does NOT credit off another element's change (element-scoped, no page-wide leak)", async () => {
    // Baseline holds only a DIFFERENT element's xpath; the resolved element has
    // no baseline entry → defer to network/URL (returns false), never credit.
    const pre = { "/html[1]/body[1]/div[9]/button[1]": fp({ kind: "primary" }) };
    const target = makeTarget(fp({ kind: "primary", cls: "ih-a ih-c" }));

    expect(await verifyDomEffect(target, clickAction, pre)).toBe(false);
  });

  it("defers (false) when no pre-baseline exists for the resolved element", async () => {
    const target = makeTarget(fp({ kind: "primary" }));

    expect(await verifyDomEffect(target, clickAction, {})).toBe(false);
  });

  it("cannot credit a self-toggling submit/advance button — empty baseline defers to network/URL", async () => {
    // executeStepWithHealing does NOT capture selectionStateByXpath for
    // submit/advance steps (captureSelectionState=false), so their `pre` map is
    // empty. Even when the resolved button toggles its OWN state on click (a
    // submit button flipping to a pressed/loading class, a "Next" flipping
    // aria-pressed), the empty baseline means no element-scoped credit — the
    // submit/advance verdict must come from a real network/URL transition.
    const submitButtonToggled = makeTarget(fp({ kind: "primary", cls: "ih-loading" }));

    expect(await verifyDomEffect(submitButtonToggled, clickAction, {})).toBe(false);
  });

  it("defers (false) when the element is gone post-click (fingerprint null)", async () => {
    const pre = { [XPATH]: fp({ kind: "tertiary" }) };
    const target = makeTarget(null);

    expect(await verifyDomEffect(target, clickAction, pre)).toBe(false);
  });
});

/**
 * Coverage for the ANCESTOR-scoped fallback: a design-system option that wraps
 * its label in a child element (Base Web `tag`, and the standard listbox idiom
 * where the option's accessible name comes from its descendant content). The
 * click resolves to the label leaf, which has no baseline entry and never
 * changes state; the selection commits on the ancestor `role="option"`. When
 * the leaf read-back can't credit, `verifyDomEffect` consults the nearest
 * baseline-present selection ancestor via the in-page walk — mocked here through
 * `makeTarget`'s `ancestorWalkResult` (the raw boolean the walk expression
 * returns, coerced by the helper via `=== true`).
 */
describe("flow-runner/verifyDomEffect — ancestor-scoped selection fallback", () => {
  // A leaf under the resolved XPATH that carries no baseline entry of its own.
  const LEAF_SELECTOR = `xpath=${XPATH}/span[1]`;
  const leafClick: Action = {
    selector: LEAF_SELECTOR,
    description: "label span inside a role=option",
    method: "click",
  } as Action;

  it("credits a selection ancestor when the clicked leaf has no baseline of its own", async () => {
    // Leaf absent from baseline; the walk (mocked true) found a baseline-present
    // role=option ancestor whose aria-selected flipped false→true.
    const target = makeTarget(null, true);

    expect(await verifyDomEffect(target, leafClick, {})).toBe(true);
  });

  it("does NOT credit when the nearest selection ancestor is unchanged", async () => {
    // Ancestor in baseline but its fingerprint didn't move (re-click of an
    // already-selected option) → walk returns false → no credit.
    const target = makeTarget(null, false);

    expect(await verifyDomEffect(target, leafClick, {})).toBe(false);
  });

  it("does NOT credit a disclosure-only ancestor (no selection marker) → walk false", async () => {
    // A leaf under an aria-expanded / data-state open|closed button has no
    // eligible selection ancestor; the in-page walk returns false.
    const target = makeTarget(null, false);

    expect(await verifyDomEffect(target, leafClick, {})).toBe(false);
  });

  it("does NOT credit when the eligible ancestor is not in the baseline (newly mounted) → walk false", async () => {
    const target = makeTarget(null, false);

    expect(await verifyDomEffect(target, leafClick, {})).toBe(false);
  });

  it("credits the direct-hit option via the fast path WITHOUT consulting the walk", async () => {
    // The clicked node IS the option and its own fingerprint moved: the leaf
    // read-back returns true before the ancestor walk is ever reached. Force the
    // walk to false to prove the fast path is what credits it.
    const pre = { [XPATH]: fp({ ariaSelected: "false" }) };
    const target = makeTarget(fp({ ariaSelected: "true" }), false);

    expect(await verifyDomEffect(target, clickAction, pre)).toBe(true);
  });

  it("cannot credit on a submit step: empty baseline → walk finds no key → false", async () => {
    // executeStepWithHealing captures no selectionStateByXpath for submit/advance
    // steps, so `pre` is empty; the ancestor walk has no baseline key to match
    // and returns false, so the submit verdict must come from network/URL.
    const target = makeTarget(null, false);

    expect(await verifyDomEffect(target, leafClick, {})).toBe(false);
  });

  it("credits a class-only hashed swap on a marker-bearing ancestor (aria unchanged)", async () => {
    // Base Web swaps only its hashed styletron class on the ancestor option;
    // aria is unchanged. The walk (mocked true) reflects that the ancestor's
    // `cls` field moved.
    const target = makeTarget(null, true);

    expect(await verifyDomEffect(target, leafClick, {})).toBe(true);
  });
});
