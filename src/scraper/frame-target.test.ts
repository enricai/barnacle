import { describe, expect, it } from "vitest";

import { resolveFrameTarget } from "@/scraper/frame-target";

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
      if (!selector || !Object.hasOwn(iframes, selector)) return null;
      return iframes[selector] ?? null;
    },
    locator: (selector: string) => ({ scope: "main" as const, selector }),
    frames: () => frames,
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

    const target = await resolveFrameTarget(page as never, "iframe#does_not_exist");

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

    const target = await resolveFrameTarget(page as never, "iframe#talemetry_apply_iframe");

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

    const target = await resolveFrameTarget(page as never, "iframe#talemetry_apply_iframe");

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
