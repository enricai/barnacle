import { describe, expect, it } from "vitest";

import { resolveFrameTarget } from "@/scraper/frame-target";

/**
 * Fake `Frame`: `evaluate` answers `"location.href"` with the given url (or
 * rejects, simulating a torn-down cross-origin frame whose CDP session no
 * longer responds) and otherwise echoes the expression for delegation checks.
 */
function makeFakeFrame(url: string | { rejects: true }) {
  return {
    evaluate: async (expr: unknown) => {
      if (typeof url !== "string") throw new Error("frame detached");
      if (expr === "location.href") return url;
      return `frame-evaluated:${String(expr)}`;
    },
    locator: (selector: string) => ({ scope: "frame" as const, selector }),
  };
}

/**
 * Fake `Page`: `elements` maps a CSS selector to a DOM element description
 * (`tag` + optional `src`), mirroring what `resolveFrameTarget`'s generated
 * `document.querySelector` expression would read from a live page; `frames`
 * wires up `page.frames()` candidates.
 */
function makeFakePage(options: {
  mainUrl: string;
  elements?: Record<string, { tag: string; src?: string | null }>;
  frames?: ReturnType<typeof makeFakeFrame>[];
}) {
  const elements = options.elements ?? {};
  const frames = options.frames ?? [];
  return {
    url: () => options.mainUrl,
    title: async () => "main document title",
    evaluate: async (expr: unknown) => {
      const match = /document\.querySelector\((.+?)\)/.exec(String(expr));
      const selector = match?.[1] ? (JSON.parse(match[1]) as string) : null;
      if (!selector || !Object.hasOwn(elements, selector)) return null;
      const el = elements[selector];
      if (el?.tag !== "IFRAME") return null;
      return el.src ?? null;
    },
    locator: (selector: string) => ({ scope: "main" as const, selector }),
    frames: () => frames,
  };
}

describe("resolveFrameTarget (id-only and multi-candidate selectors)", () => {
  it("resolves a child frame by origin match for an id-only selector (no iframe tag qualifier)", async () => {
    const childFrame = makeFakeFrame("https://apply.talemetry.com/application/abc-123");
    const page = makeFakePage({
      mainUrl: "https://careers.uchealth.org/jobs/123",
      elements: {
        "#talemetry_apply_iframe": {
          tag: "IFRAME",
          src: "https://apply.talemetry.com/application/abc-123",
        },
      },
      frames: [childFrame],
    });

    const target = await resolveFrameTarget(page as never, "#talemetry_apply_iframe");

    expect(target.frame).toBe(childFrame);
    expect(target.frameSelector).toBe("#talemetry_apply_iframe");
  });

  it("picks the first frames() candidate whose origin matches, ignoring unrelated sibling frames", async () => {
    const unrelated = makeFakeFrame("https://unrelated-vendor.example.com/widget");
    const matching = makeFakeFrame("https://apply.talemetry.com/application/abc-123");
    const page = makeFakePage({
      mainUrl: "https://careers.uchealth.org/jobs/123",
      elements: {
        "iframe#talemetry_apply_iframe": {
          tag: "IFRAME",
          src: "https://apply.talemetry.com/application/abc-123",
        },
      },
      frames: [unrelated, matching],
    });

    const target = await resolveFrameTarget(page as never, "iframe#talemetry_apply_iframe");

    expect(target.frame).toBe(matching);
  });

  it("falls back to the main-frame target when the selector matches a non-iframe element", async () => {
    const page = makeFakePage({
      mainUrl: "https://careers.uchealth.org/jobs/123",
      elements: { "#not_an_iframe": { tag: "DIV" } },
      frames: [makeFakeFrame("https://apply.talemetry.com/application/abc-123")],
    });

    const target = await resolveFrameTarget(page as never, "#not_an_iframe");

    expect(target.frame).toBeNull();
    expect(target.frameSelector).toBeNull();
  });

  it("falls back to the main-frame target when the matched iframe has no src attribute", async () => {
    const page = makeFakePage({
      mainUrl: "https://careers.uchealth.org/jobs/123",
      elements: { "iframe#lazy": { tag: "IFRAME", src: null } },
      frames: [makeFakeFrame("https://apply.talemetry.com/application/abc-123")],
    });

    const target = await resolveFrameTarget(page as never, "iframe#lazy");

    expect(target.frame).toBeNull();
    expect(target.frameSelector).toBeNull();
  });

  it("skips a candidate frame whose evaluate() rejects and still resolves a later matching candidate", async () => {
    const detached = makeFakeFrame({ rejects: true });
    const matching = makeFakeFrame("https://apply.talemetry.com/application/abc-123");
    const page = makeFakePage({
      mainUrl: "https://careers.uchealth.org/jobs/123",
      elements: {
        "iframe#talemetry_apply_iframe": {
          tag: "IFRAME",
          src: "https://apply.talemetry.com/application/abc-123",
        },
      },
      frames: [detached, matching],
    });

    const target = await resolveFrameTarget(page as never, "iframe#talemetry_apply_iframe");

    expect(target.frame).toBe(matching);
  });

  it("matches by origin even when the iframe src and the live frame's location.href differ by path/query", async () => {
    const childFrame = makeFakeFrame(
      "https://apply.talemetry.com/application/abc-123?step=basic-info"
    );
    const page = makeFakePage({
      mainUrl: "https://careers.uchealth.org/jobs/123",
      elements: {
        "iframe#talemetry_apply_iframe": {
          tag: "IFRAME",
          src: "https://apply.talemetry.com/application/abc-123",
        },
      },
      frames: [childFrame],
    });

    const target = await resolveFrameTarget(page as never, "iframe#talemetry_apply_iframe");

    expect(target.frame).toBe(childFrame);
    expect(await target.url()).toBe(
      "https://apply.talemetry.com/application/abc-123?step=basic-info"
    );
  });
});
