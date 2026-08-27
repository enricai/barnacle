import type { Action } from "@browserbasehq/stagehand";
import { describe, expect, it, vi } from "vitest";

import { verifyDomEffect } from "@/scraper/flow-runner";
import type { FrameTarget } from "@/scraper/frame-target";

/**
 * Coverage for the disabled-target veto in `verifyDomEffect`'s click branch:
 * a click that resolves to a disabled (native `disabled` or
 * `aria-disabled="true"`) element can't have done anything, so the verifier
 * must return `false` regardless of what the element-scoped or
 * ancestor-scoped selection read-backs report.
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
 * branch runs, in resolution order: the disabled-target probe (`isDisabled`,
 * uniquely identified by `el.disabled === true`), the ancestor-walk
 * expression (`SELECTION_ROLES`), the element-fingerprint read
 * (`getAttribute("kind")`), and the `el.type` probe (default fallthrough).
 * `disabled` defaults to `false` so every existing selection-read-back case
 * is unaffected unless a case opts in.
 */
function makeTarget(
  postFingerprint: Fingerprint | null,
  ancestorWalkResult: boolean,
  disabled: boolean
): FrameTarget {
  const evaluate = vi.fn(async (expr: string) => {
    if (expr.includes("el.disabled === true")) return disabled;
    if (expr.includes("SELECTION_ROLES")) return ancestorWalkResult;
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
  description: "submit option",
  method: "click",
} as Action;

describe("flow-runner/verifyDomEffect — disabled-target veto", () => {
  it("never verifies a click on a disabled element, even when the element's own fingerprint changed", async () => {
    const pre = { [XPATH]: fp({ kind: "tertiary", cls: "ih-a ih-b" }) };
    const target = makeTarget(fp({ kind: "primary", cls: "ih-a ih-c" }), false, true);

    expect(await verifyDomEffect(target, clickAction, pre)).toBe(false);
  });

  it("never verifies a click on an aria-disabled element, even when a baseline-present ancestor changed", async () => {
    const target = makeTarget(null, true, true);

    expect(await verifyDomEffect(target, clickAction, {})).toBe(false);
  });

  it("control group: the same fingerprint change with no disabled attribute still verifies", async () => {
    const pre = { [XPATH]: fp({ kind: "tertiary", cls: "ih-a ih-b" }) };
    const target = makeTarget(fp({ kind: "primary", cls: "ih-a ih-c" }), false, false);

    expect(await verifyDomEffect(target, clickAction, pre)).toBe(true);
  });
});
