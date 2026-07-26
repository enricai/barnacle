import { describe, expect, it, vi } from "vitest";
import type { FrameTarget } from "@/scraper/frame-target";
import {
  buildHopSelector,
  resolveFrameTarget,
  sleep as sleepMs,
  waitForChildFrameReady,
} from "@/scraper/frame-target";

/**
 * Minimal fake `Frame`: just enough surface for `resolveFrameTarget` and the
 * resulting `FrameTarget` to exercise — `evaluate` (used both to read
 * `location.href` during resolution and to prove delegation afterward) and
 * `locator` (proves delegation without needing a real CDP-backed Locator).
 */
function makeFakeFrame(url: string) {
  return {
    evaluate: async (expr: unknown) => {
      if (expr === "location.href") return url;
      return `frame-evaluated:${String(expr)}`;
    },
    locator: (selector: string) => ({ scope: "frame" as const, selector }),
  };
}

/**
 * Minimal fake `Page`: `frames()` returns whatever child frames the test
 * wires up, `evaluate` answers `resolveFrameTarget`'s generated
 * "read the iframe's src" expression string by extracting the CSS selector
 * it was built with (mirroring how the real Stagehand `Page.evaluate` would
 * execute that same string against a live DOM), and `url`/`title`/`locator`
 * prove main-frame delegation.
 */
function makeFakePage(options: {
  mainUrl: string;
  iframes?: Record<string, string>;
  frames?: ReturnType<typeof makeFakeFrame>[];
}) {
  const iframes = options.iframes ?? {};
  const frames = options.frames ?? [];
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
  };
}

/**
 * Mutable variant of `makeFakePage`: `mountIframe`/`attachFrame` let a test
 * change what `evaluate`/`frames()` report *between* `resolveFrameTarget`'s
 * polls, scripting the exact mid-flow scenario from the bug report — an
 * `<iframe>` (or its matching `frames()` entry) that doesn't exist at the
 * first pass but appears once an earlier flow step mounts it.
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
    mountIframe: (selector: string, src: string): void => {
      iframes[selector] = src;
    },
    attachFrame: (frame: ReturnType<typeof makeFakeFrame>): void => {
      frames.push(frame);
    },
  };
}

describe("resolveFrameTarget", () => {
  it("returns the main-frame target when frameSelector is undefined", async () => {
    const page = makeFakePage({ mainUrl: "https://careers.uchealth.org/jobs/123" });

    const target = await resolveFrameTarget(page as never);

    expect(target.frame).toBeNull();
    expect(target.frameSelector).toBeNull();
    expect(await target.url()).toBe("https://careers.uchealth.org/jobs/123");
  });

  it("returns the main-frame target when frameSelector is null", async () => {
    const page = makeFakePage({ mainUrl: "https://careers.uchealth.org/jobs/123" });

    const target = await resolveFrameTarget(page as never, null);

    expect(target.frame).toBeNull();
    expect(target.frameSelector).toBeNull();
  });

  it("resolves a FrameTarget bound to the child Frame whose url matches the iframe's origin", async () => {
    const childFrame = makeFakeFrame("https://apply.talemetry.com/application/abc-123");
    const page = makeFakePage({
      mainUrl: "https://careers.uchealth.org/jobs/123",
      iframes: {
        "iframe#talemetry_apply_iframe": "https://apply.talemetry.com/application/abc-123",
      },
      frames: [childFrame],
    });

    const target = await resolveFrameTarget(page as never, "iframe#talemetry_apply_iframe");

    expect(target.frame).toBe(childFrame);
    expect(target.frameSelector).toBe("iframe#talemetry_apply_iframe");
    expect(await target.url()).toBe("https://apply.talemetry.com/application/abc-123");
  });

  it("delegates evaluate/locator to the resolved child Frame, not the main Page", async () => {
    const childFrame = makeFakeFrame("https://apply.talemetry.com/application/abc-123");
    const page = makeFakePage({
      mainUrl: "https://careers.uchealth.org/jobs/123",
      iframes: {
        "iframe#talemetry_apply_iframe": "https://apply.talemetry.com/application/abc-123",
      },
      frames: [childFrame],
    });

    const target = await resolveFrameTarget(page as never, "iframe#talemetry_apply_iframe");

    expect(await target.evaluate("document.title")).toBe("frame-evaluated:document.title");
    expect(target.locator("input#firstName")).toEqual({
      scope: "frame",
      selector: "input#firstName",
    });
  });

  it("falls back to the main-frame target when the selector matches no element in the DOM", async () => {
    const page = makeFakePage({
      mainUrl: "https://careers.uchealth.org/jobs/123",
      frames: [makeFakeFrame("https://apply.talemetry.com/application/abc-123")],
    });

    const target = await resolveFrameTarget(page as never, "iframe#does_not_exist", {
      timeoutMs: 20,
      pollMs: 5,
    });

    expect(target.frame).toBeNull();
    expect(target.frameSelector).toBeNull();
  });

  it("falls back to the main-frame target when no page.frames() entry matches the iframe's origin", async () => {
    const page = makeFakePage({
      mainUrl: "https://careers.uchealth.org/jobs/123",
      iframes: {
        "iframe#talemetry_apply_iframe": "https://apply.talemetry.com/application/abc-123",
      },
      frames: [makeFakeFrame("https://unrelated-vendor.example.com/widget")],
    });

    const target = await resolveFrameTarget(page as never, "iframe#talemetry_apply_iframe", {
      timeoutMs: 20,
      pollMs: 5,
    });

    expect(target.frame).toBeNull();
    expect(target.frameSelector).toBeNull();
  });

  it("falls back to the main-frame target when frames() is empty", async () => {
    const page = makeFakePage({
      mainUrl: "https://careers.uchealth.org/jobs/123",
      iframes: {
        "iframe#talemetry_apply_iframe": "https://apply.talemetry.com/application/abc-123",
      },
      frames: [],
    });

    const target = await resolveFrameTarget(page as never, "iframe#talemetry_apply_iframe", {
      timeoutMs: 20,
      pollMs: 5,
    });

    expect(target.frame).toBeNull();
    expect(target.frameSelector).toBeNull();
  });

  it("resolves a childFrameTarget once the iframe element is mounted mid-flow, after being absent on the first poll", async () => {
    const childFrame = makeFakeFrame("https://apply.talemetry.com/application/abc-123");
    const page = makeMutableFakePage({
      mainUrl: "https://careers.uchealth.org/jobs/123",
      frames: [childFrame],
    });

    const target = resolveFrameTarget(page as never, "iframe#talemetry_apply_iframe", {
      timeoutMs: 1000,
      pollMs: 5,
    });

    await sleepMs(15);
    page.mountIframe(
      "iframe#talemetry_apply_iframe",
      "https://apply.talemetry.com/application/abc-123"
    );

    const resolved = await target;
    expect(resolved.frame).toBe(childFrame);
    expect(resolved.frameSelector).toBe("iframe#talemetry_apply_iframe");
  });

  it("resolves a childFrameTarget by origin match once the iframe's src is populated on a later poll, after the element existed with an empty src (and multiple ambiguous candidates) on the first poll", async () => {
    const matchingFrame = makeFakeFrame("https://apply.talemetry.com/application/abc-123");
    const unrelatedFrame = makeFakeFrame("https://unrelated-vendor.example.com/widget");
    let src: string | null = null;
    const page = {
      url: () => "https://careers.uchealth.org/jobs/123",
      title: async () => "main document title",
      evaluate: async (expr: unknown) => {
        const match = /document\.querySelector\((.+?)\)/.exec(String(expr));
        const selector = match?.[1] ? (JSON.parse(match[1]) as string) : null;
        if (selector !== "iframe#talemetry_apply_iframe") return { matched: false, src: null };
        return { matched: true, src };
      },
      locator: (selector: string) => ({ scope: "main" as const, selector }),
      frames: () => [unrelatedFrame, matchingFrame],
    };

    const target = resolveFrameTarget(page as never, "iframe#talemetry_apply_iframe", {
      timeoutMs: 1000,
      pollMs: 5,
    });

    await sleepMs(15);
    src = "https://apply.talemetry.com/application/abc-123";

    const resolved = await target;
    expect(resolved.frame).toBe(matchingFrame);
    expect(resolved.frameSelector).toBe("iframe#talemetry_apply_iframe");
  });

  it("resolves a childFrameTarget by element identity on the very first poll when the iframe's src is unreadable but exactly one candidate frame exists", async () => {
    const onlyCandidate = makeFakeFrame("https://apply.talemetry.com/application/abc-123");
    const page = {
      url: () => "https://careers.uchealth.org/jobs/123",
      title: async () => "main document title",
      evaluate: async () => ({ matched: true, src: null }),
      locator: (selector: string) => ({ scope: "main" as const, selector }),
      frames: () => [onlyCandidate],
    };

    const target = await resolveFrameTarget(page as never, "iframe#talemetry_apply_iframe", {
      timeoutMs: 1000,
      pollMs: 5,
    });

    expect(target.frame).toBe(onlyCandidate);
    expect(target.frameSelector).toBe("iframe#talemetry_apply_iframe");
  });

  it("resolves a childFrameTarget once a matching frames() entry attaches, after the iframe element already existed with no matching frame", async () => {
    const page = makeMutableFakePage({
      mainUrl: "https://careers.uchealth.org/jobs/123",
      iframes: {
        "iframe#talemetry_apply_iframe": "https://apply.talemetry.com/application/abc-123",
      },
      frames: [],
    });

    const target = resolveFrameTarget(page as never, "iframe#talemetry_apply_iframe", {
      timeoutMs: 1000,
      pollMs: 5,
    });

    await sleepMs(15);
    const childFrame = makeFakeFrame("https://apply.talemetry.com/application/abc-123");
    page.attachFrame(childFrame);

    const resolved = await target;
    expect(resolved.frame).toBe(childFrame);
    expect(resolved.frameSelector).toBe("iframe#talemetry_apply_iframe");
  });

  it("does not throw and falls back to the main-frame target when the iframe element never mounts before the retry budget expires", async () => {
    const page = makeMutableFakePage({
      mainUrl: "https://careers.uchealth.org/jobs/123",
      frames: [],
    });

    const target = await resolveFrameTarget(page as never, "iframe#talemetry_apply_iframe", {
      timeoutMs: 20,
      pollMs: 5,
    });

    expect(target.frame).toBeNull();
    expect(target.frameSelector).toBeNull();
  });

  it("does not throw and falls back to the main-frame target when no matching frame attaches before the retry budget expires", async () => {
    const page = makeMutableFakePage({
      mainUrl: "https://careers.uchealth.org/jobs/123",
      iframes: {
        "iframe#talemetry_apply_iframe": "https://apply.talemetry.com/application/abc-123",
      },
      frames: [],
    });

    const target = await resolveFrameTarget(page as never, "iframe#talemetry_apply_iframe", {
      timeoutMs: 20,
      pollMs: 5,
    });

    expect(target.frame).toBeNull();
    expect(target.frameSelector).toBeNull();
  });

  it("uses the top document's title for a resolved child-frame target", async () => {
    const childFrame = makeFakeFrame("https://apply.talemetry.com/application/abc-123");
    const page = makeFakePage({
      mainUrl: "https://careers.uchealth.org/jobs/123",
      iframes: {
        "iframe#talemetry_apply_iframe": "https://apply.talemetry.com/application/abc-123",
      },
      frames: [childFrame],
    });

    const target = await resolveFrameTarget(page as never, "iframe#talemetry_apply_iframe");

    expect(await target.title()).toBe("main document title");
  });
});

describe("buildHopSelector", () => {
  it("composes a frame selector and an inner selector with the hop separator", () => {
    expect(buildHopSelector("#f", "#btn")).toBe("#f >> #btn");
  });

  it("returns the inner selector unchanged for a main-frame target (frameSelector null)", () => {
    expect(buildHopSelector(null, "#btn")).toBe("#btn");
  });

  it("returns the inner selector unchanged for a main-frame target (frameSelector undefined)", () => {
    expect(buildHopSelector(undefined, "#btn")).toBe("#btn");
  });

  it("does not double-append a hop when the frame selector already contains '>>'", () => {
    expect(buildHopSelector("#f >> #nested", "#btn")).toBe("#f >> #nested >> #btn");
  });
});

/**
 * Minimal fake `FrameTarget`: `frame` is a truthy sentinel so
 * `waitForChildFrameReady` doesn't take its main-frame no-op early return,
 * and `evaluateImpl` lets each test script the readyState sequence returned
 * across successive polls.
 */
function makeFakeTarget(evaluateImpl: () => Promise<string>): FrameTarget {
  return {
    frame: {} as FrameTarget["frame"],
    frameSelector: "iframe#talemetry_apply_iframe",
    evaluate: evaluateImpl as FrameTarget["evaluate"],
    locator: (selector: string) => ({ scope: "frame" as const, selector }) as never,
    url: () => Promise.resolve("https://apply.talemetry.com/application/abc-123"),
    title: () => Promise.resolve("main document title"),
  };
}

describe("waitForChildFrameReady", () => {
  it("resolves immediately for a main-frame target (frame: null)", async () => {
    const evaluate = vi.fn();
    const target: FrameTarget = {
      frame: null,
      frameSelector: null,
      evaluate,
      locator: (selector: string) => ({ scope: "main" as const, selector }) as never,
      url: () => Promise.resolve("https://careers.uchealth.org/jobs/123"),
      title: () => Promise.resolve("main document title"),
    };

    await waitForChildFrameReady(target);

    expect(evaluate).not.toHaveBeenCalled();
  });

  it("resolves on the first check when the frame document is already ready", async () => {
    const evaluate = vi.fn().mockResolvedValue("complete");
    const target = makeFakeTarget(evaluate);

    await waitForChildFrameReady(target, { timeoutMs: 1000, pollMs: 10 });

    expect(evaluate).toHaveBeenCalledTimes(1);
  });

  it("resolves once readyState transitions to interactive after polling", async () => {
    const states = ["loading", "loading", "interactive"];
    const evaluate = vi.fn().mockImplementation(() => Promise.resolve(states.shift()));
    const target = makeFakeTarget(evaluate);

    await waitForChildFrameReady(target, { timeoutMs: 1000, pollMs: 5 });

    expect(evaluate).toHaveBeenCalledTimes(3);
  });

  it("resolves (does not reject) once the timeout elapses for a frame that never becomes ready", async () => {
    const evaluate = vi.fn().mockResolvedValue("loading");
    const target = makeFakeTarget(evaluate);

    await expect(
      waitForChildFrameReady(target, { timeoutMs: 30, pollMs: 10 })
    ).resolves.toBeUndefined();
    expect(evaluate.mock.calls.length).toBeGreaterThan(1);
  });

  it("treats a rejected evaluate (torn-down frame) as not-ready and still resolves within the timeout", async () => {
    const evaluate = vi.fn().mockRejectedValue(new Error("frame detached"));
    const target = makeFakeTarget(evaluate);

    await expect(
      waitForChildFrameReady(target, { timeoutMs: 30, pollMs: 10 })
    ).resolves.toBeUndefined();
  });
});
