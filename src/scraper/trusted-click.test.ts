import { describe, expect, it, vi } from "vitest";
import type { FrameTarget } from "@/scraper/frame-target";
import {
  CENTRE_AND_HIT_TEST_FN,
  type CentredHitTestResult,
  clickAfterCentredHitTest,
  clickCentredTrusted,
} from "@/scraper/trusted-click";

function fakeTarget(results: CentredHitTestResult[], order: string[]): FrameTarget {
  const queue = [...results];
  const last = results[results.length - 1];
  return {
    frame: null,
    frameSelector: null,
    evaluate: vi.fn(async () => {
      order.push("evaluate");
      return queue.shift() ?? last;
    }) as unknown as FrameTarget["evaluate"],
    locator: vi.fn(() => ({
      click: async (): Promise<void> => {
        order.push("click");
      },
    })) as unknown as FrameTarget["locator"],
    url: async () => "https://example.com",
    title: async () => "",
  };
}

describe("clickCentredTrusted", () => {
  it("centres via scrollIntoView before a single click when not occluded", async () => {
    const order: string[] = [];
    const target = fakeTarget([{ state: "hit" }], order);
    await clickCentredTrusted(target, "#save");
    expect(order).toEqual(["evaluate", "click"]);
    const expr = vi.mocked(target.evaluate).mock.calls[0]?.[0] as string;
    expect(expr).toContain('block: "center"');
    expect(expr).toContain("querySelector");
  });

  it("uses document.evaluate for xpath= selectors", async () => {
    const order: string[] = [];
    const target = fakeTarget([{ state: "hit" }], order);
    await clickCentredTrusted(target, "xpath=//button[1]");
    expect(vi.mocked(target.evaluate).mock.calls[0]?.[0]).toContain("document.evaluate");
  });

  it("re-centres and retries when a fixed footer covers the point", async () => {
    const order: string[] = [];
    const target = fakeTarget(
      [{ state: "occluded", occluder: "footer#bar" }, { state: "hit" }],
      order
    );
    await clickCentredTrusted(target, "#save");
    expect(order).toEqual(["evaluate", "evaluate", "click"]);
  });

  it("throws without clicking when still occluded", async () => {
    const order: string[] = [];
    const target = fakeTarget([{ state: "occluded", occluder: "footer#bar" }], order);
    await expect(clickCentredTrusted(target, "#save", { attempts: 2 })).rejects.toThrow(
      /occluded by footer#bar after 2 attempts/
    );
    expect(order).not.toContain("click");
  });
});

describe("clickAfterCentredHitTest", () => {
  it("passes the centring function to the injected element evaluator (deep-locator form)", async () => {
    const click = vi.fn(async () => {});
    const evaluateOnElement = vi.fn(async () => ({ state: "hit" }) as CentredHitTestResult);
    await clickAfterCentredHitTest({ click }, evaluateOnElement);
    expect(evaluateOnElement).toHaveBeenCalledWith(CENTRE_AND_HIT_TEST_FN);
    expect(click).toHaveBeenCalledTimes(1);
  });

  it("throws on a missing element without clicking", async () => {
    const click = vi.fn(async () => {});
    await expect(
      clickAfterCentredHitTest({ click }, async () => ({ state: "missing" }), { attempts: 1 })
    ).rejects.toThrow(/not in the document/);
    expect(click).not.toHaveBeenCalled();
  });
});
