import type { Page } from "@browserbasehq/stagehand";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { dispatchBehavioralSignals } from "@/scraper/behavioral-signals";
import type { FrameTarget } from "@/scraper/frame-target";

function makePage(): Page {
  return {
    sendCDP: vi.fn().mockResolvedValue(undefined),
    evaluate: vi.fn().mockResolvedValue(undefined),
  } as unknown as Page;
}

/**
 * Minimal fake `FrameTarget` bound to a resolved child frame: `frame.session`
 * is the seam `dispatchBehavioralSignals` should route CDP mouse events
 * through, and `evaluate` is the seam it should route the scroll through.
 */
function makeChildFrameTarget(): {
  target: FrameTarget;
  sessionSend: ReturnType<typeof vi.fn>;
  evaluate: ReturnType<typeof vi.fn>;
} {
  const sessionSend = vi.fn().mockResolvedValue(undefined);
  const evaluate = vi.fn().mockResolvedValue(undefined);
  const target = {
    frame: { session: { send: sessionSend } },
    frameSelector: "iframe#apply_frame",
    evaluate,
    locator: vi.fn(),
    url: vi.fn(),
    title: vi.fn(),
  } as unknown as FrameTarget;
  return { target, sessionSend, evaluate };
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

  it("given a main-frame FrameTarget (frame: null), behaves identically to omitting it", async () => {
    const mainFrameTarget = {
      frame: null,
      frameSelector: null,
      evaluate: (expr: unknown) => page.evaluate(expr as never),
      locator: vi.fn(),
      url: vi.fn(),
      title: vi.fn(),
    } as unknown as FrameTarget;

    await dispatchBehavioralSignals(page, mainFrameTarget);

    const calls = (page.sendCDP as ReturnType<typeof vi.fn>).mock.calls as [string, unknown][];
    expect(calls).toHaveLength(2);
    expect(calls[0]?.[0]).toBe("Input.dispatchMouseEvent");
    expect(calls[1]?.[0]).toBe("Input.dispatchMouseEvent");
    expect(page.evaluate).toHaveBeenCalledOnce();
    expect(page.evaluate).toHaveBeenCalledWith("window.scrollBy(0, 50)");
  });
});

describe("scraper/behavioral-signals dispatchBehavioralSignals with a child FrameTarget", () => {
  let page: Page;

  beforeEach(() => {
    page = makePage();
  });

  it("dispatches both Input.dispatchMouseEvent calls through the frame's own CDP session", async () => {
    const { target, sessionSend } = makeChildFrameTarget();

    await dispatchBehavioralSignals(page, target);

    expect(sessionSend).toHaveBeenCalledTimes(2);
    expect(sessionSend.mock.calls[0]?.[0]).toBe("Input.dispatchMouseEvent");
    expect(sessionSend.mock.calls[1]?.[0]).toBe("Input.dispatchMouseEvent");
    expect(page.sendCDP).not.toHaveBeenCalled();
  });

  it("sends mouseMoved type with numeric x/y through the frame's session", async () => {
    const { target, sessionSend } = makeChildFrameTarget();

    await dispatchBehavioralSignals(page, target);

    const calls = sessionSend.mock.calls as [string, Record<string, unknown>][];
    expect(calls[0]?.[1]).toMatchObject({ type: "mouseMoved" });
    expect(typeof calls[0]?.[1]?.x).toBe("number");
    expect(typeof calls[0]?.[1]?.y).toBe("number");
  });

  it("scrolls via the FrameTarget's evaluate, not page.evaluate", async () => {
    const { target, evaluate } = makeChildFrameTarget();

    await dispatchBehavioralSignals(page, target);

    expect(evaluate).toHaveBeenCalledOnce();
    expect(evaluate).toHaveBeenCalledWith("window.scrollBy(0, 50)");
    expect(page.evaluate).not.toHaveBeenCalled();
  });
});
