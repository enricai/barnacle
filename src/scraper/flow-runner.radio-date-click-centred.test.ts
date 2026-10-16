import { describe, expect, it, vi } from "vitest";
import { applyRadioSelection, fillTextDatepickerInput } from "@/scraper/flow-runner";
import type { FrameTarget } from "@/scraper/frame-target";

interface Harness {
  target: FrameTarget;
  order: string[];
}

function harness(opts: { clickFails?: boolean; readbackOk?: boolean[]; centreState?: string }): Harness {
  const order: string[] = [];
  const readbacks = [...(opts.readbackOk ?? [])];
  const target = {
    frame: null,
    frameSelector: null,
    evaluate: vi.fn(async (expr: string) => {
      if (expr.includes("scrollIntoView")) {
        order.push("centre");
        return { state: opts.centreState ?? "hit" };
      }
      if (expr.includes("rb.checked")) {
        order.push("readback");
        return { ok: readbacks.shift() ?? false };
      }
      if (expr.includes("react-datepicker__input-container")) return { match: true };
      return { ok: false };
    }),
    locator: vi.fn((sel: string) => ({
      first() {
        return this;
      },
      fill: async (): Promise<void> => {
        throw new Error("no keyboard");
      },
      type: async (): Promise<void> => {},
      click: async (): Promise<void> => {
        order.push(`click:${sel}`);
        if (opts.clickFails) throw new Error("click failed");
      },
    })),
    url: async () => "https://example.com",
    title: async () => "",
  } as unknown as FrameTarget;
  return { target, order };
}

describe("applyRadioSelection centred clicks", () => {
  it("centres before the Tier A click", async () => {
    const { target, order } = harness({ readbackOk: [true] });
    expect(await applyRadioSelection(target, 0, 0, { id: "r1", xpath: "" })).toBe(true);
    expect(order.slice(0, 2)).toEqual(["centre", expect.stringMatching(/^click:/)]);
  });

  it("falls through to Tier B with its own centring when Tier A readback fails", async () => {
    const { target, order } = harness({ readbackOk: [false, true] });
    expect(await applyRadioSelection(target, 0, 0, { id: "r1", xpath: "" })).toBe(true);
    const clicks = order.filter((o) => o.startsWith("click:"));
    expect(clicks[1]).toContain("label[@for=");
    expect(order.filter((o) => o === "centre")).toHaveLength(2);
  });
});

describe("fillTextDatepickerInput centred click", () => {
  it("centres before the open click and returns strategy none on click failure", async () => {
    const ok = harness({});
    await fillTextDatepickerInput(ok.target, "xpath=//input[@id='d']", "01/02/2025");
    const centreIdx = ok.order.indexOf("centre");
    expect(centreIdx).toBeGreaterThanOrEqual(0);
    expect(ok.order[centreIdx + 1]).toMatch(/^click:/);

    const bad = harness({ clickFails: true });
    const res = await fillTextDatepickerInput(bad.target, "xpath=//input[@id='d']", "01/02/2025");
    expect(res?.strategy).toBe("none");
  });
});

describe("strict centring failure", () => {
  it("never clicks when the target cannot be centred", async () => {
    const { target, order } = harness({ centreState: "occluded", readbackOk: [true] });
    expect(await applyRadioSelection(target, 0, 0, { id: "r1", xpath: "" })).toBe(false);
    expect(order.some((o) => o.startsWith("click:"))).toBe(false);

    const date = harness({ centreState: "occluded" });
    const res = await fillTextDatepickerInput(date.target, "xpath=//input[@id='d']", "01/02/2025");
    expect(res?.strategy).toBe("none");
    expect(date.order.some((o) => o.startsWith("click:"))).toBe(false);
  });
});
