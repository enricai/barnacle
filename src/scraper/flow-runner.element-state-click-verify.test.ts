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
 * A FrameTarget whose `evaluate` answers the two browser expressions the click
 * branch runs: the `el.type` probe (returns `null` for a plain <button>) and
 * the element-fingerprint read (returns `postFingerprint`). The pre-baseline is
 * passed to `verifyDomEffect` directly.
 */
function makeTarget(postFingerprint: Fingerprint | null): FrameTarget {
  const evaluate = vi.fn(async (expr: string) => {
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
