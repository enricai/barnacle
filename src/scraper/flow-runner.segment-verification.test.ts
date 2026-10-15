import { describe, expect, it, vi } from "vitest";
import { verifyDomEffect, verifyFillReadback } from "@/scraper/flow-runner";
import type { FrameTarget } from "@/scraper/frame-target";

function segmentTarget(): { target: FrameTarget; fill: ReturnType<typeof vi.fn> } {
  const fill = vi.fn();
  const locator = {
    first: () => locator,
    inputValue: async (): Promise<string> => "2001",
    fill,
    type: vi.fn(),
  };
  const target = {
    evaluate: async (): Promise<unknown> => ({
      outcome: "segment",
      postValue: "2001",
      tag: "input",
    }),
    locator: () => locator,
  } as unknown as FrameTarget;
  return { target, fill };
}

describe("spinbutton segment verification", () => {
  it("does not credit a lone segment and never retypes it", async () => {
    const { target, fill } = segmentTarget();
    const ok = await verifyDomEffect(target, {
      selector: "xpath=//input[1]",
      method: "fill",
      arguments: ["012020"],
      description: "",
    } as never);
    expect(ok).toBe(false);
    expect(fill).not.toHaveBeenCalled();
  });

  it("reports the segment outcome from the readback", async () => {
    const { target } = segmentTarget();
    const r = await verifyFillReadback(target, "xpath=//input[1]", "012020");
    expect(r?.outcome).toBe("segment");
  });
});
