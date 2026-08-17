import { describe, expect, it } from "vitest";
import type { FrameTarget } from "@/scraper/frame-target";
import { resolveFrameTarget, waitForChildFrameReady } from "@/scraper/frame-target";

/**
 * Minimal fake `Frame`: `evaluate` answers `location.href` with whatever the
 * test currently has it report, letting a single frame instance model a
 * same-origin re-navigation (the URL changes but the frame identity doesn't).
 */
let frameStalenessFakeCounter = 0;

function makeFakeFrame(getUrl: () => string) {
  return {
    frameId: `frame-staleness-fake-${frameStalenessFakeCounter++}`,
    evaluate: async (expr: unknown) => {
      if (/document\.body/.test(String(expr))) return true;
      if (expr === "location.href") return getUrl();
      return `frame-evaluated:${String(expr)}`;
    },
    locator: (selector: string) => ({ scope: "frame" as const, selector }),
  };
}

/**
 * Mutable fake `Page`: matches `frame-target.test.ts`'s `makeMutableFakePage`
 * shape (copied, not imported — those helpers are module-private) plus a
 * `removeFrame` counterpart so a test can simulate a resolved frame
 * detaching from `page.frames()` between resolution passes.
 */
function makeMutableFakePage(options: {
  mainUrl: string;
  iframes?: Record<string, string>;
  frames?: ReturnType<typeof makeFakeFrame>[];
}) {
  const iframes = { ...(options.iframes ?? {}) };
  const frames = [...(options.frames ?? [])];
  return {
    url: () => options.mainUrl,
    title: async () => "main document title",
    evaluate: async (expr: unknown) => {
      const match = /document\.querySelector\((.+?)\)/.exec(String(expr));
      const selector = match?.[1] ? (JSON.parse(match[1]) as string) : null;
      if (!selector || !Object.hasOwn(iframes, selector)) return { matched: false, src: null };
      return { matched: true, src: iframes[selector] ?? null };
    },
    locator: (selector: string) => ({ scope: "main" as const, selector }),
    frames: () => frames,
    mainFrameId: () => "frame-staleness-main-frame",
    mountIframe: (selector: string, src: string): void => {
      iframes[selector] = src;
    },
    attachFrame: (frame: ReturnType<typeof makeFakeFrame>): void => {
      frames.push(frame);
    },
    removeFrame: (frame: ReturnType<typeof makeFakeFrame>): void => {
      const index = frames.indexOf(frame);
      if (index !== -1) frames.splice(index, 1);
    },
  };
}

describe("resolveFrameTarget re-resolution against a stale child frame", () => {
  it("still resolves a child-bound target after the frame's location.href changes to a same-origin path", async () => {
    let currentUrl = "https://apply.example.com/application/abc-123";
    const childFrame = makeFakeFrame(() => currentUrl);
    const page = makeMutableFakePage({
      mainUrl: "https://careers.example.org/jobs/123",
      iframes: {
        "iframe#apply_frame": "https://apply.example.com/application/abc-123",
      },
      frames: [childFrame],
    });

    const first = await resolveFrameTarget(page as never, "iframe#apply_frame");
    expect(first.frame).toBe(childFrame);

    currentUrl = "https://apply.example.com/application/abc-123/gq";

    const second = await resolveFrameTarget(page as never, "iframe#apply_frame");

    expect(second.frame).not.toBeNull();
    expect(second.frameSelector).toBe("iframe#apply_frame");
    expect(await second.url()).toBe("https://apply.example.com/application/abc-123/gq");
  });

  it("does not throw and falls back to the main-frame target when the resolved frame disappears from page.frames()", async () => {
    const childFrame = makeFakeFrame(() => "https://apply.example.com/application/abc-123");
    const page = makeMutableFakePage({
      mainUrl: "https://careers.example.org/jobs/123",
      iframes: {
        "iframe#apply_frame": "https://apply.example.com/application/abc-123",
      },
      frames: [childFrame],
    });

    const first = await resolveFrameTarget(page as never, "iframe#apply_frame");
    expect(first.frame).toBe(childFrame);

    page.removeFrame(childFrame);

    const second = await resolveFrameTarget(page as never, "iframe#apply_frame", {
      timeoutMs: 20,
      pollMs: 5,
    });

    expect(second.frame).toBeNull();
    expect(second.frameSelector).toBeNull();
  });

  it("rebinds to a replacement frame, without throwing, when the resolved frame is swapped for a new matching one", async () => {
    const originalFrame = makeFakeFrame(() => "https://apply.example.com/application/abc-123");
    const page = makeMutableFakePage({
      mainUrl: "https://careers.example.org/jobs/123",
      iframes: {
        "iframe#apply_frame": "https://apply.example.com/application/abc-123",
      },
      frames: [originalFrame],
    });

    const first = await resolveFrameTarget(page as never, "iframe#apply_frame");
    expect(first.frame).toBe(originalFrame);

    page.removeFrame(originalFrame);
    const replacementFrame = makeFakeFrame(() => "https://apply.example.com/application/abc-123");
    page.attachFrame(replacementFrame);

    const second = await resolveFrameTarget(page as never, "iframe#apply_frame");

    expect(second.frame).toBe(replacementFrame);
    expect(second.frameSelector).toBe("iframe#apply_frame");
  });
});

describe("waitForChildFrameReady against a frame that dies mid-poll", () => {
  it("resolves (does not reject) when a resolveFrameTarget-produced target reports not-ready, then detaches on a later poll — a transition, not a steady-state rejection", async () => {
    const readyStates = ["loading", "detached", "detached"];
    const childFrame = {
      frameId: "frame-staleness-dying-child",
      evaluate: async (expr: unknown) => {
        if (/document\.body/.test(String(expr))) return true;
        if (expr === "location.href") return "https://apply.example.com/application/abc-123";
        if (expr !== "document.readyState") return `frame-evaluated:${String(expr)}`;
        const nextState = readyStates.shift() ?? "detached";
        if (nextState === "detached") throw new Error("frame detached");
        return nextState;
      },
      locator: (selector: string) => ({ scope: "frame" as const, selector }),
    };
    const page = makeMutableFakePage({
      mainUrl: "https://careers.example.org/jobs/123",
      iframes: {
        "iframe#apply_frame": "https://apply.example.com/application/abc-123",
      },
      frames: [childFrame],
    });

    const target: FrameTarget = await resolveFrameTarget(page as never, "iframe#apply_frame");
    expect(target.frame).toBe(childFrame);

    await expect(
      waitForChildFrameReady(target, { timeoutMs: 30, pollMs: 5 })
    ).resolves.toBeUndefined();
    expect(readyStates.length).toBeLessThan(3);
  });
});
