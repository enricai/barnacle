import type { Action, Stagehand } from "@browserbasehq/stagehand";
import { describe, expect, it, vi } from "vitest";

import { resolveFrameTarget } from "@/scraper/frame-target";
import { guardedObserve } from "@/scraper/stagehand-guard";

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

  it("resolves the child frame when passed only the iframe-id hop of a '>> ' selector (Stagehand's own hop notation)", async () => {
    const childFrame = makeFakeFrame("https://apply.talemetry.com/application/abc-123");
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

    // `resolveFrameTarget` resolves the iframe boundary itself; the part of a
    // Stagehand `deepLocator` hop selector after " >> " addresses an element
    // *inside* the resolved frame and is never passed to `document.querySelector`
    // here — callers pass just the iframe-id hop (the part before " >> ").
    const target = await resolveFrameTarget(page as never, "iframe#talemetry_apply_iframe");

    expect(target.frame).toBe(childFrame);
    expect(target.frameSelector).toBe("iframe#talemetry_apply_iframe");
  });

  it("rejects rather than silently falling back when a full '>> ' hop selector is passed through unsplit", async () => {
    // `document.querySelector` throws a SyntaxError on the combinator-bearing
    // selector `"iframe#x >> inner"` (it isn't valid CSS) — the fake models
    // that by rejecting, mirroring what a live `page.evaluate` would surface.
    // `resolveFrameTarget`'s top-level `page.evaluate(iframeSrcExpr)` call has
    // no `.catch`, so this documents that callers must split the hop selector
    // themselves (pass only the iframe-id hop) rather than the raw hop string.
    const page = {
      url: () => "https://careers.uchealth.org/jobs/123",
      title: async () => "main document title",
      evaluate: async () => {
        throw new DOMException(
          "Failed to execute 'querySelector' on 'Document': " +
            "'iframe#talemetry_apply_iframe >> inner' is not a valid selector.",
          "SyntaxError"
        );
      },
      locator: (selector: string) => ({ scope: "main" as const, selector }),
      frames: () => [makeFakeFrame("https://apply.talemetry.com/application/abc-123")],
    };

    await expect(
      resolveFrameTarget(page as never, "iframe#talemetry_apply_iframe >> inner")
    ).rejects.toThrow(/not a valid selector/);
  });
});

describe("frame-resolution seam: resolveFrameTarget -> guardedObserve (Talemetry shape)", () => {
  it("resolves the Talemetry child frame over an unrelated sibling and scopes guardedObserve with a '>>' hop selector", async () => {
    const unrelatedSibling = makeFakeFrame("https://unrelated-vendor.example.com/widget");
    const talemetryFrame = makeFakeFrame(
      "https://apply.talemetry.com/application/abc-123?step=basic-info"
    );
    const page = makeFakePage({
      mainUrl: "https://careers.uchealth.org/jobs/123-registered-nurse",
      elements: {
        "iframe#talemetry_apply_iframe": {
          tag: "IFRAME",
          src: "https://apply.talemetry.com/application/abc-123",
        },
      },
      frames: [unrelatedSibling, talemetryFrame],
    });

    const target = await resolveFrameTarget(page as never, "iframe#talemetry_apply_iframe");

    expect(target.frame).toBe(talemetryFrame);
    expect(target.frame).not.toBe(unrelatedSibling);
    expect(target.frameSelector).toBe("iframe#talemetry_apply_iframe");

    const manualApplicationAction: Action = {
      selector: "xpath=//button[@id='manual_application']",
      description: "Manual Application button",
      method: "click",
    };
    const observeSpy = vi.fn().mockResolvedValue([manualApplicationAction]);
    const stagehand = { observe: observeSpy } as unknown as Stagehand;
    const captureFn = vi.fn().mockResolvedValue(undefined);

    const actions = await guardedObserve(
      stagehand,
      "find the Manual Application button",
      undefined,
      captureFn,
      target
    );

    expect(actions).toEqual([manualApplicationAction]);
    expect(observeSpy).toHaveBeenCalledWith("find the Manual Application button", {
      selector: "iframe#talemetry_apply_iframe >> *",
    });
  });
});
