import type { Action } from "@browserbasehq/stagehand";
import { describe, expect, it, vi } from "vitest";

import { verifyDomEffect } from "@/scraper/flow-runner";
import type { FrameTarget } from "@/scraper/frame-target";

/**
 * Coverage for the SIBLING committed-value fallback in `verifyDomEffect`'s
 * click branch: a generic custom combobox — a trigger with a visible label,
 * an options list of `.result-selectable` items, and a same-container hidden
 * `<input name="...">` that a real selection handler commits to — where the
 * click re-renders only the trigger's visible label text and never touches
 * the clicked option's OWN fingerprint or any selection ancestor's. Neither
 * the leaf read-back nor the ancestor walk can credit that click; only a diff
 * of the hidden committed-value control against its own baseline entry
 * proves the selection actually landed.
 */

const OPTION_XPATH = "/html[1]/body[1]/div[1]/ul[1]/li[2]";
const OPTION_SELECTOR = `xpath=${OPTION_XPATH}`;

const optionClick: Action = {
  selector: OPTION_SELECTOR,
  description: "Remote option in a generic custom combobox",
  method: "click",
} as Action;

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
 * A FrameTarget whose `evaluate` answers the three expressions the click
 * branch tries in order: the leaf/element fingerprint (unmoved — the option's
 * own class/aria never changes on this widget), the ancestor walk (mocked
 * `false` — no eligible selection ancestor either), and the sibling
 * committed-value search (`querySelectorAll("input,select")`), which resolves
 * to `siblingCommitted` — the one signal this widget actually exposes.
 */
function makeTarget(siblingCommitted: boolean): FrameTarget {
  const leafFingerprint = fp({});
  const evaluate = vi.fn(async (expr: string) => {
    if (expr.includes('querySelectorAll("input,select")')) {
      // Mirrors the real function's own veto: with no baseline entries at
      // all (`BASE = {}`) there is nothing to diff a sibling control
      // against, so it can never credit the click regardless of what the
      // widget's live DOM looks like.
      if (expr.includes("const BASE = {}")) return false;
      return siblingCommitted;
    }
    if (expr.includes("SELECTION_ROLES")) return false;
    if (expr.includes('getAttribute("kind")')) return leafFingerprint;
    return null;
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

describe("flow-runner/verifyDomEffect — sibling committed-control selection fallback", () => {
  it("does NOT credit a click that only mutates the trigger's visible label text", async () => {
    // The clicked option's own fingerprint is unmoved, no selection ancestor
    // moved either, and the hidden committed-value control never changed
    // (siblingCommitted=false) — the widget re-rendered only the trigger
    // label. That is not a real commit; the step must not be scored verified.
    const pre = { [OPTION_XPATH]: fp({}) };
    const target = makeTarget(false);

    expect(await verifyDomEffect(target, optionClick, pre)).toBe(false);
  });

  it("credits a click that commits the hidden associated control's value", async () => {
    // Same leaf/ancestor non-signal as above, but the sibling hidden
    // `<input name=...>` a real selection handler writes to DID change value
    // relative to its own baseline entry — the sibling read-back credits it.
    const pre = { [OPTION_XPATH]: fp({}) };
    const target = makeTarget(true);

    expect(await verifyDomEffect(target, optionClick, pre)).toBe(true);
  });

  it("does NOT credit off a baseline-less option even when a sibling control happens to differ", async () => {
    // No baseline entry for the resolved element, and no baseline entries at
    // all in the pre-map — the element-scoped fast path and ancestor walk
    // require SOME baseline presence upstream, and the sibling read-back has
    // nothing to diff a committed control against either. The empty-baseline
    // case still routes through the SAME three-stage check and defers
    // correctly (false) rather than trusting an unrelated control.
    const target = makeTarget(true);

    expect(await verifyDomEffect(target, optionClick, {})).toBe(false);
  });
});
