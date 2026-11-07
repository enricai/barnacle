import { describe, expect, it, vi } from "vitest";
import type { FrameTarget } from "@/scraper/frame-target";
import {
  centreSelectorForClick,
  clickCentredTrusted,
  isClickPointUnobscured,
  probeClickPoint,
} from "@/scraper/trusted-click";

const COMPOSITE =
  "/html[1]/body[1]/main[1]/div[1]/div[1]/span[1]/iframe[1]/html[1]/body[1]/div[2]/div[3]/div[1]/div[1]/form[1]/div[1]/div[1]/div[1]/a[1]";
const FRAME_RELATIVE =
  "/html[1]/body[1]/div[2]/div[3]/div[1]/div[1]/form[1]/div[1]/div[1]/div[1]/a[1]";

function fakeTarget(frameSelector: string | null): FrameTarget {
  return {
    frame: null,
    frameSelector,
    evaluate: vi.fn(async () => ({ state: "hit" })) as unknown as FrameTarget["evaluate"],
    locator: vi.fn(() => ({
      click: async (): Promise<void> => {},
    })) as unknown as FrameTarget["locator"],
    url: async () => "https://example.com",
    title: async () => "",
  };
}

function expr(t: FrameTarget): string {
  return vi.mocked(t.evaluate).mock.calls[0]?.[0] as string;
}

const entries: Array<[string, (t: FrameTarget, sel: string) => Promise<unknown>]> = [
  ["clickCentredTrusted", (t, s) => clickCentredTrusted(t, s)],
  ["centreSelectorForClick", (t, s) => centreSelectorForClick(t, s)],
  ["probeClickPoint", (t, s) => probeClickPoint(t, s)],
  ["isClickPointUnobscured", (t, s) => isClickPointUnobscured(t, s)],
];

describe.each(entries)("%s with a composite xpath", (_name, run) => {
  for (const sel of [COMPOSITE, `xpath=${COMPOSITE}`]) {
    it(`re-anchors to the frame document (${sel.startsWith("xpath=") ? "prefixed" : "bare"})`, async () => {
      const t = fakeTarget("iframe#widget");
      await run(t, sel);
      const e = expr(t);
      expect(e).toContain(FRAME_RELATIVE);
      expect(e).not.toContain("iframe[1]/html[1]");
    });
  }

  it("passes a main-frame xpath through unchanged", async () => {
    const t = fakeTarget(null);
    await run(t, COMPOSITE);
    expect(expr(t)).toContain(COMPOSITE);
  });

  it("passes a css selector through unchanged", async () => {
    const t = fakeTarget("iframe#widget");
    await run(t, "#save");
    expect(expr(t)).toContain('document.querySelector("#save")');
  });
});
