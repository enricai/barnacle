import type { Page } from "@browserbasehq/stagehand";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { dispatchBehavioralSignals } from "@/scraper/behavioral-signals";

function makePage(): Page {
  return {
    sendCDP: vi.fn().mockResolvedValue(undefined),
    evaluate: vi.fn().mockResolvedValue(undefined),
  } as unknown as Page;
}

describe("scraper/behavioral-signals dispatchBehavioralSignals", () => {
  let page: Page;

  beforeEach(() => {
    page = makePage();
  });

  it("sends exactly two Input.dispatchMouseEvent calls", async () => {
    await dispatchBehavioralSignals(page);

    const calls = (page.sendCDP as ReturnType<typeof vi.fn>).mock.calls as [string, unknown][];
    expect(calls).toHaveLength(2);
    expect(calls[0]?.[0]).toBe("Input.dispatchMouseEvent");
    expect(calls[1]?.[0]).toBe("Input.dispatchMouseEvent");
  });

  it("sends mouseMoved type on both CDP calls", async () => {
    await dispatchBehavioralSignals(page);

    const calls = (page.sendCDP as ReturnType<typeof vi.fn>).mock.calls as [
      string,
      Record<string, unknown>,
    ][];
    expect(calls[0]?.[1]).toMatchObject({ type: "mouseMoved" });
    expect(calls[1]?.[1]).toMatchObject({ type: "mouseMoved" });
  });

  it("calls page.evaluate with window.scrollBy(0, 50)", async () => {
    await dispatchBehavioralSignals(page);

    expect(page.evaluate).toHaveBeenCalledOnce();
    expect(page.evaluate).toHaveBeenCalledWith("window.scrollBy(0, 50)");
  });

  it("CDP calls carry numeric x and y coordinates", async () => {
    await dispatchBehavioralSignals(page);

    const calls = (page.sendCDP as ReturnType<typeof vi.fn>).mock.calls as [
      string,
      Record<string, unknown>,
    ][];
    expect(typeof calls[0]?.[1].x).toBe("number");
    expect(typeof calls[0]?.[1].y).toBe("number");
    expect(typeof calls[1]?.[1].x).toBe("number");
    expect(typeof calls[1]?.[1].y).toBe("number");
  });
});
