import type { Action, Stagehand } from "@browserbasehq/stagehand";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { loggerStub } = vi.hoisted(() => ({
  loggerStub: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    errorWithStack: vi.fn(),
  },
}));
vi.mock("@/lib/logging", () => ({
  getLogger: () => loggerStub,
}));

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
      if (!selector || !Object.hasOwn(elements, selector)) return { matched: false, src: null };
      const el = elements[selector];
      if (el?.tag !== "IFRAME") return { matched: false, src: null };
      return { matched: true, src: el.src ?? null };
    },
    locator: (selector: string) => ({ scope: "main" as const, selector }),
    frames: () => frames,
  };
}

describe("resolveFrameTarget (id-only and multi-candidate selectors)", () => {
  it("resolves a child frame by origin match for an id-only selector (no iframe tag qualifier)", async () => {
    const childFrame = makeFakeFrame("https://apply.example.com/application/abc-123");
    const page = makeFakePage({
      mainUrl: "https://careers.example.org/jobs/123",
      elements: {
        "#apply_frame": {
          tag: "IFRAME",
          src: "https://apply.example.com/application/abc-123",
        },
      },
      frames: [childFrame],
    });

    const target = await resolveFrameTarget(page as never, "#apply_frame");

    expect(target.frame).toBe(childFrame);
    expect(target.frameSelector).toBe("#apply_frame");
  });

  it("picks the first frames() candidate whose origin matches, ignoring unrelated sibling frames", async () => {
    const unrelated = makeFakeFrame("https://unrelated-vendor.example.com/widget");
    const matching = makeFakeFrame("https://apply.example.com/application/abc-123");
    const page = makeFakePage({
      mainUrl: "https://careers.example.org/jobs/123",
      elements: {
        "iframe#apply_frame": {
          tag: "IFRAME",
          src: "https://apply.example.com/application/abc-123",
        },
      },
      frames: [unrelated, matching],
    });

    const target = await resolveFrameTarget(page as never, "iframe#apply_frame");

    expect(target.frame).toBe(matching);
  });

  it("falls back to the main-frame target when the selector matches a non-iframe element", async () => {
    const page = makeFakePage({
      mainUrl: "https://careers.example.org/jobs/123",
      elements: { "#not_an_iframe": { tag: "DIV" } },
      frames: [makeFakeFrame("https://apply.example.com/application/abc-123")],
    });

    const target = await resolveFrameTarget(page as never, "#not_an_iframe", {
      timeoutMs: 20,
      pollMs: 5,
    });

    expect(target.frame).toBeNull();
    expect(target.frameSelector).toBeNull();
  });

  it("resolves by element identity when the matched iframe has no src attribute but exactly one candidate frame exists", async () => {
    const onlyCandidate = makeFakeFrame("https://apply.example.com/application/abc-123");
    const page = makeFakePage({
      mainUrl: "https://careers.example.org/jobs/123",
      elements: { "iframe#lazy": { tag: "IFRAME", src: null } },
      frames: [onlyCandidate],
    });

    const target = await resolveFrameTarget(page as never, "iframe#lazy", {
      timeoutMs: 20,
      pollMs: 5,
    });

    expect(target.frame).toBe(onlyCandidate);
    expect(target.frameSelector).toBe("iframe#lazy");
  });

  it("falls back to the main-frame target when the matched iframe has no src attribute and multiple candidate frames exist (ambiguous identity match)", async () => {
    const page = makeFakePage({
      mainUrl: "https://careers.example.org/jobs/123",
      elements: { "iframe#lazy": { tag: "IFRAME", src: null } },
      frames: [
        makeFakeFrame("https://apply.example.com/application/abc-123"),
        makeFakeFrame("https://unrelated-vendor.example.com/widget"),
      ],
    });

    const target = await resolveFrameTarget(page as never, "iframe#lazy", {
      timeoutMs: 20,
      pollMs: 5,
    });

    expect(target.frame).toBeNull();
    expect(target.frameSelector).toBeNull();
  });

  it("falls back to the main-frame target when the matched iframe has no src attribute and no candidate frames exist", async () => {
    const page = makeFakePage({
      mainUrl: "https://careers.example.org/jobs/123",
      elements: { "iframe#lazy": { tag: "IFRAME", src: null } },
      frames: [],
    });

    const target = await resolveFrameTarget(page as never, "iframe#lazy", {
      timeoutMs: 20,
      pollMs: 5,
    });

    expect(target.frame).toBeNull();
    expect(target.frameSelector).toBeNull();
  });

  it("skips a candidate frame whose evaluate() rejects and still resolves a later matching candidate", async () => {
    const detached = makeFakeFrame({ rejects: true });
    const matching = makeFakeFrame("https://apply.example.com/application/abc-123");
    const page = makeFakePage({
      mainUrl: "https://careers.example.org/jobs/123",
      elements: {
        "iframe#apply_frame": {
          tag: "IFRAME",
          src: "https://apply.example.com/application/abc-123",
        },
      },
      frames: [detached, matching],
    });

    const target = await resolveFrameTarget(page as never, "iframe#apply_frame");

    expect(target.frame).toBe(matching);
  });

  it("matches by origin even when the iframe src and the live frame's location.href differ by path/query", async () => {
    const childFrame = makeFakeFrame(
      "https://apply.example.com/application/abc-123?step=basic-info"
    );
    const page = makeFakePage({
      mainUrl: "https://careers.example.org/jobs/123",
      elements: {
        "iframe#apply_frame": {
          tag: "IFRAME",
          src: "https://apply.example.com/application/abc-123",
        },
      },
      frames: [childFrame],
    });

    const target = await resolveFrameTarget(page as never, "iframe#apply_frame");

    expect(target.frame).toBe(childFrame);
    expect(await target.url()).toBe(
      "https://apply.example.com/application/abc-123?step=basic-info"
    );
  });

  it("resolves the child frame when passed only the iframe-id hop of a '>> ' selector (Stagehand's own hop notation)", async () => {
    const childFrame = makeFakeFrame("https://apply.example.com/application/abc-123");
    const page = makeFakePage({
      mainUrl: "https://careers.example.org/jobs/123",
      elements: {
        "iframe#apply_frame": {
          tag: "IFRAME",
          src: "https://apply.example.com/application/abc-123",
        },
      },
      frames: [childFrame],
    });

    // `resolveFrameTarget` resolves the iframe boundary itself; the part of a
    // Stagehand `deepLocator` hop selector after " >> " addresses an element
    // *inside* the resolved frame and is never passed to `document.querySelector`
    // here — callers pass just the iframe-id hop (the part before " >> ").
    const target = await resolveFrameTarget(page as never, "iframe#apply_frame");

    expect(target.frame).toBe(childFrame);
    expect(target.frameSelector).toBe("iframe#apply_frame");
  });

  it("rejects rather than silently falling back when a full '>> ' hop selector is passed through unsplit", async () => {
    // `document.querySelector` throws a SyntaxError on the combinator-bearing
    // selector `"iframe#x >> inner"` (it isn't valid CSS) — the fake models
    // that by rejecting, mirroring what a live `page.evaluate` would surface.
    // `resolveFrameTarget`'s top-level `page.evaluate(iframeSrcExpr)` call has
    // no `.catch`, so this documents that callers must split the hop selector
    // themselves (pass only the iframe-id hop) rather than the raw hop string.
    const page = {
      url: () => "https://careers.example.org/jobs/123",
      title: async () => "main document title",
      evaluate: async () => {
        throw new DOMException(
          "Failed to execute 'querySelector' on 'Document': " +
            "'iframe#apply_frame >> inner' is not a valid selector.",
          "SyntaxError"
        );
      },
      locator: (selector: string) => ({ scope: "main" as const, selector }),
      frames: () => [makeFakeFrame("https://apply.example.com/application/abc-123")],
    };

    await expect(resolveFrameTarget(page as never, "iframe#apply_frame >> inner")).rejects.toThrow(
      /not a valid selector/
    );
  });
});

describe("frame-resolution seam: resolveFrameTarget -> guardedObserve (the embedded apply wizard shape)", () => {
  it("resolves the embedded-apply child frame over an unrelated sibling and scopes guardedObserve with a '>>' hop selector", async () => {
    const unrelatedSibling = makeFakeFrame("https://unrelated-vendor.example.com/widget");
    const embeddedApplyFrame = makeFakeFrame(
      "https://apply.example.com/application/abc-123?step=basic-info"
    );
    const page = makeFakePage({
      mainUrl: "https://careers.example.org/jobs/123-registered-nurse",
      elements: {
        "iframe#apply_frame": {
          tag: "IFRAME",
          src: "https://apply.example.com/application/abc-123",
        },
      },
      frames: [unrelatedSibling, embeddedApplyFrame],
    });

    const target = await resolveFrameTarget(page as never, "iframe#apply_frame");

    expect(target.frame).toBe(embeddedApplyFrame);
    expect(target.frame).not.toBe(unrelatedSibling);
    expect(target.frameSelector).toBe("iframe#apply_frame");

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
      selector: "iframe#apply_frame >> *",
    });
  });
});

/**
 * Mutable-state fake `Page`: unlike `makeFakePage`, `elements`/`frames` are
 * read fresh on every call via getters so a test can flip the iframe element
 * or `frames()` list into existence partway through — modeling an OOPIF that
 * attaches only after an earlier flow step (e.g. an "Apply now" click) runs.
 */
function makeMutableFakePage(options: {
  mainUrl: string;
  getElements: () => Record<string, { tag: string; src?: string | null }>;
  getFrames: () => ReturnType<typeof makeFakeFrame>[];
}) {
  return {
    url: () => options.mainUrl,
    title: async () => "main document title",
    evaluate: async (expr: unknown) => {
      const match = /document\.querySelector\((.+?)\)/.exec(String(expr));
      const selector = match?.[1] ? (JSON.parse(match[1]) as string) : null;
      const elements = options.getElements();
      if (!selector || !Object.hasOwn(elements, selector)) return { matched: false, src: null };
      const el = elements[selector];
      if (el?.tag !== "IFRAME") return { matched: false, src: null };
      return { matched: true, src: el.src ?? null };
    },
    locator: (selector: string) => ({ scope: "main" as const, selector }),
    frames: () => options.getFrames(),
  };
}

describe("resolveFrameTarget (mid-flow iframe attachment: bounded retry + fallback logging)", () => {
  beforeEach(() => {
    loggerStub.warn.mockClear();
  });

  it("resolves to the child frame once frames() lists the matching frame on a later poll (K empty polls, then attached)", async () => {
    const childFrame = makeFakeFrame("https://apply.example.com/application/abc-123");
    let pollCount = 0;
    const ATTACH_ON_POLL = 3;
    const page = makeMutableFakePage({
      mainUrl: "https://careers.example.org/jobs/123",
      getElements: () => ({
        "#apply_frame": {
          tag: "IFRAME",
          src: "https://apply.example.com/application/abc-123",
        },
      }),
      getFrames: () => {
        pollCount += 1;
        return pollCount >= ATTACH_ON_POLL ? [childFrame] : [];
      },
    });

    const target = await resolveFrameTarget(page as never, "#apply_frame", {
      timeoutMs: 500,
      pollMs: 5,
    });

    expect(target.frame).toBe(childFrame);
    expect(target.frameSelector).toBe("#apply_frame");
    expect(pollCount).toBeGreaterThanOrEqual(ATTACH_ON_POLL);
    expect(loggerStub.warn).not.toHaveBeenCalled();
  });

  it("resolves to the child frame once the #sel iframe element itself appears on a later poll", async () => {
    const childFrame = makeFakeFrame("https://apply.example.com/application/abc-123");
    let pollCount = 0;
    const ATTACH_ON_POLL = 3;
    const page = makeMutableFakePage({
      mainUrl: "https://careers.example.org/jobs/123",
      getElements: (): Record<string, { tag: string; src?: string | null }> => {
        pollCount += 1;
        return pollCount >= ATTACH_ON_POLL
          ? {
              "#apply_frame": {
                tag: "IFRAME",
                src: "https://apply.example.com/application/abc-123",
              },
            }
          : {};
      },
      getFrames: () => [childFrame],
    });

    const target = await resolveFrameTarget(page as never, "#apply_frame", {
      timeoutMs: 500,
      pollMs: 5,
    });

    expect(target.frame).toBe(childFrame);
    expect(pollCount).toBeGreaterThanOrEqual(ATTACH_ON_POLL);
    expect(loggerStub.warn).not.toHaveBeenCalled();
  });

  it("falls back to the main-frame target within the bounded timeout and emits exactly one warn naming the selector when the frame never attaches", async () => {
    const page = makeMutableFakePage({
      mainUrl: "https://careers.example.org/jobs/123",
      getElements: () => ({}),
      getFrames: () => [],
    });

    const target = await resolveFrameTarget(page as never, "#never_attaches", {
      timeoutMs: 40,
      pollMs: 10,
    });

    expect(target.frame).toBeNull();
    expect(target.frameSelector).toBeNull();
    expect(loggerStub.warn).toHaveBeenCalledTimes(1);
    expect(loggerStub.warn).toHaveBeenCalledWith(expect.stringContaining("#never_attaches"));
  });

  it("polls until the configured default elapses (not a small hardcoded window) before falling back when opts.timeoutMs is omitted, without wall-clocking it", async () => {
    vi.useFakeTimers();
    try {
      let pollCount = 0;
      const page = makeMutableFakePage({
        mainUrl: "https://careers.example.org/jobs/123",
        getElements: () => {
          pollCount += 1;
          return {};
        },
        getFrames: () => [],
      });

      const targetPromise = resolveFrameTarget(page as never, "#never_attaches");
      await vi.advanceTimersByTimeAsync(120_000);
      const target = await targetPromise;

      expect(target.frame).toBeNull();
      expect(target.frameSelector).toBeNull();
      // Several polls, not just the pre-loop check — proves the loop actually
      // ran for the default's duration instead of bailing immediately.
      expect(pollCount).toBeGreaterThan(3);
      expect(loggerStub.warn).toHaveBeenCalledTimes(1);
      const [warnMessage] = loggerStub.warn.mock.calls[0] as [string];
      // Not pinned to a literal default value (5_000 today, config-raised
      // later) — only that the applied default is the real production one,
      // not some small test-only window.
      const appliedDefaultMs = Number(/did not attach within (\d+)ms/.exec(warnMessage)?.[1]);
      expect(appliedDefaultMs).toBeGreaterThanOrEqual(5_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns the main-frame target with zero polling and zero delay when frameSelector is null/undefined", async () => {
    const framesSpy = vi.fn().mockReturnValue([]);
    const evaluateSpy = vi.fn().mockResolvedValue(null);
    const page = {
      url: () => "https://careers.example.org/jobs/123",
      title: async () => "main document title",
      evaluate: evaluateSpy,
      locator: (selector: string) => ({ scope: "main" as const, selector }),
      frames: framesSpy,
    };

    const undefinedTarget = await resolveFrameTarget(page as never, undefined);
    const nullTarget = await resolveFrameTarget(page as never, null);

    expect(undefinedTarget.frame).toBeNull();
    expect(undefinedTarget.frameSelector).toBeNull();
    expect(nullTarget.frame).toBeNull();
    expect(nullTarget.frameSelector).toBeNull();
    expect(evaluateSpy).not.toHaveBeenCalled();
    expect(framesSpy).not.toHaveBeenCalled();
    expect(loggerStub.warn).not.toHaveBeenCalled();
  });
});
