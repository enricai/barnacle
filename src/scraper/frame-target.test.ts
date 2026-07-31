import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Small stand-in for the real `config.scraper.*` frame timeouts, mocked so
 * default-path tests (no explicit `opts`) run fast and still prove the
 * defaults are actually sourced from `@/config` rather than a hardcoded
 * constant — a regression back to a hardcoded default would blow through
 * these small budgets and fail the corresponding test's elapsed-time bound.
 */
const { mockScraperConfig } = vi.hoisted(() => ({
  mockScraperConfig: {
    frameReadyTimeoutMs: 40,
    frameDocumentReadyTimeoutMs: 30,
    frameEvaluateTimeoutMs: 15,
  },
}));
vi.mock("@/config", () => ({ config: { scraper: mockScraperConfig } }));

import type { FrameTarget } from "@/scraper/frame-target";

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

import {
  buildHopSelector,
  resolveFrameTarget,
  sleep as sleepMs,
  waitForChildFrameReady,
} from "@/scraper/frame-target";

beforeEach(() => {
  loggerStub.warn.mockClear();
});

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

  it("composes a frame selector with an xpath-shaped inner selector without trimming its leading slashes", () => {
    expect(
      buildHopSelector(
        "#talemetry_apply_iframe",
        "//button[normalize-space()='Manual Application']"
      )
    ).toBe("#talemetry_apply_iframe >> //button[normalize-space()='Manual Application']");
  });

  it("does not double-append the separator when the frame selector already ends with '>>' and the inner selector is xpath-shaped", () => {
    expect(
      buildHopSelector(
        "#talemetry_apply_iframe >>",
        "//button[normalize-space()='Manual Application']"
      )
    ).toBe("#talemetry_apply_iframe >> //button[normalize-space()='Manual Application']");
  });

  it("returns an xpath-shaped inner selector unchanged for a main-frame target (frameSelector null)", () => {
    expect(buildHopSelector(null, "//button[normalize-space()='Manual Application']")).toBe(
      "//button[normalize-space()='Manual Application']"
    );
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

  it("polls until the configured default elapses (not a small hardcoded window) before proceeding when opts.timeoutMs is omitted, without wall-clocking it", async () => {
    // The suite-wide mock keeps every other default-path case fast; this one
    // has to observe a production-scale window, so it drives the knob to the
    // real `config.scraper.frameDocumentReadyTimeoutMs` default and simulates
    // its duration with fake timers rather than wall-clocking it.
    const PRODUCTION_DOCUMENT_READY_TIMEOUT_MS = 5_000;
    const mockedTimeoutMs = mockScraperConfig.frameDocumentReadyTimeoutMs;
    mockScraperConfig.frameDocumentReadyTimeoutMs = PRODUCTION_DOCUMENT_READY_TIMEOUT_MS;
    vi.useFakeTimers();
    try {
      const evaluate = vi.fn().mockResolvedValue("loading");
      const target = makeFakeTarget(evaluate);

      const readyPromise = waitForChildFrameReady(target);
      await vi.advanceTimersByTimeAsync(120_000);
      await readyPromise;

      // Several polls, not just the pre-loop check — proves the loop actually
      // ran for the configured default's duration instead of bailing immediately.
      expect(evaluate.mock.calls.length).toBeGreaterThan(3);
      expect(loggerStub.warn).toHaveBeenCalledTimes(1);
      const [warnMessage] = loggerStub.warn.mock.calls[0] as [string];
      const appliedDefaultMs = Number(/still not ready after (\d+)ms/.exec(warnMessage)?.[1]);
      expect(appliedDefaultMs).toBe(PRODUCTION_DOCUMENT_READY_TIMEOUT_MS);
    } finally {
      vi.useRealTimers();
      mockScraperConfig.frameDocumentReadyTimeoutMs = mockedTimeoutMs;
    }
  });
});

describe("resolveFrameTarget: bounded against a never-settling evaluate", () => {
  it("falls back to the main-frame target and logs the warn within its configured timeout, instead of hanging, when the iframe-src evaluate never settles", async () => {
    const evaluate = vi.fn().mockReturnValue(new Promise(() => {}));
    const page = {
      url: () => "https://careers.uchealth.org/jobs/123",
      title: async () => "main document title",
      evaluate,
      locator: (selector: string) => ({ scope: "main" as const, selector }),
      frames: () => [],
    };

    const start = Date.now();
    const target = await resolveFrameTarget(page as never, "iframe#talemetry_apply_iframe", {
      timeoutMs: 40,
      pollMs: 10,
      evaluateTimeoutMs: 10,
    });
    const elapsed = Date.now() - start;

    expect(target.frame).toBeNull();
    expect(target.frameSelector).toBeNull();
    expect(elapsed).toBeLessThan(1000);
  });

  it("still propagates a genuine (non-timeout) evaluate rejection from the top-level src probe unchanged", async () => {
    const originalError = new Error("boom: not a valid selector");
    const page = {
      url: () => "https://careers.uchealth.org/jobs/123",
      title: async () => "main document title",
      evaluate: () => Promise.reject(originalError),
      locator: (selector: string) => ({ scope: "main" as const, selector }),
      frames: () => [],
    };

    await expect(
      resolveFrameTarget(page as never, "iframe#talemetry_apply_iframe", {
        timeoutMs: 40,
        pollMs: 10,
        evaluateTimeoutMs: 10,
      })
    ).rejects.toBe(originalError);
  });

  it("defaults timeoutMs/evaluateTimeoutMs from config.scraper.* when opts is omitted, still returning the main-frame target instead of hanging on a never-settling evaluate", async () => {
    const page = {
      url: () => "https://careers.uchealth.org/jobs/123",
      title: async () => "main document title",
      evaluate: () => new Promise(() => {}),
      locator: (selector: string) => ({ scope: "main" as const, selector }),
      frames: () => [],
    };

    const start = Date.now();
    const target = await resolveFrameTarget(page as never, "iframe#talemetry_apply_iframe");
    const elapsed = Date.now() - start;

    expect(target.frame).toBeNull();
    expect(target.frameSelector).toBeNull();
    // Bounded near the mocked config.scraper.frameReadyTimeoutMs (40ms), not
    // the production default (20_000ms) — proves the default is sourced
    // from config rather than a hardcoded constant.
    expect(elapsed).toBeLessThan(1000);
  });

  it("carries the declared frame selector on the main-frame target returned by a failed resolution, so a caller can retry resolution later", async () => {
    const page = {
      url: () => "https://careers.uchealth.org/jobs/123",
      title: async () => "main document title",
      evaluate: async () => ({ matched: false, src: null }),
      locator: (selector: string) => ({ scope: "main" as const, selector }),
      frames: () => [],
    };

    const target = await resolveFrameTarget(page as never, "iframe#talemetry_apply_iframe", {
      timeoutMs: 20,
      pollMs: 5,
    });

    expect(target.frame).toBeNull();
    expect(target.frameSelector).toBeNull();
    expect(target.declaredFrameSelector).toBe("iframe#talemetry_apply_iframe");
  });

  it("does not set declaredFrameSelector when no frame was ever requested (frameSelector null/undefined)", async () => {
    const page = {
      url: () => "https://careers.uchealth.org/jobs/123",
      title: async () => "main document title",
      evaluate: vi.fn(),
      locator: (selector: string) => ({ scope: "main" as const, selector }),
      frames: () => [],
    };

    const target = await resolveFrameTarget(page as never, undefined);

    expect(target.declaredFrameSelector).toBeNull();
  });

  it("honors an explicit evaluateTimeoutMs on the no-selector fast path instead of the config default", async () => {
    const page = {
      url: () => "https://careers.uchealth.org/jobs/123",
      title: async () => "main document title",
      evaluate: () => new Promise(() => {}),
      locator: (selector: string) => ({ scope: "main" as const, selector }),
      frames: () => [],
    };

    const target = await resolveFrameTarget(page as never, null, { evaluateTimeoutMs: 10 });

    const start = Date.now();
    await expect(target.evaluate("document.title")).rejects.toMatchObject({
      name: "WatchdogTimeoutError",
    });
    expect(Date.now() - start).toBeLessThan(1000);
  });
});

/**
 * A candidate `page.frames()` entry whose `location.href` evaluate never
 * settles — models an OOPIF whose CDP session is wedged, the trigger for the
 * `(1 + frames) * evaluateTimeoutMs` blowout `resolveFrameTarget`'s total
 * attach budget must stay bounded against.
 */
function makeHangingFrame() {
  return {
    evaluate: () => new Promise<never>(() => {}),
    locator: (selector: string) => ({ scope: "frame" as const, selector }),
  };
}

describe("resolveFrameTarget: bounds the total attach budget across candidate probes", () => {
  it("keeps a single resolution pass near one evaluate budget when several page.frames() candidates never settle, instead of one evaluateTimeoutMs per candidate", async () => {
    const page = makeFakePage({
      mainUrl: "https://careers.uchealth.org/jobs/123",
      iframes: {
        "iframe#talemetry_apply_iframe": "https://apply.talemetry.com/application/abc-123",
      },
      frames: Array.from({ length: 5 }, () => makeHangingFrame()) as never,
    });

    const start = Date.now();
    const target = await resolveFrameTarget(page as never, "iframe#talemetry_apply_iframe", {
      timeoutMs: 0,
      evaluateTimeoutMs: 100,
    });
    const elapsed = Date.now() - start;

    expect(target.frame).toBeNull();
    expect(target.frameSelector).toBeNull();
    expect(target.declaredFrameSelector).toBe("iframe#talemetry_apply_iframe");
    // Unbounded, this pays 5 * evaluateTimeoutMs (~500ms) sequentially probing
    // every hanging candidate before the caller ever sees a deadline check.
    expect(elapsed).toBeLessThan(250);
  });

  it("stays within the attach budget plus at most one bounded probe when several candidates never settle across multiple polls", async () => {
    vi.useFakeTimers();
    try {
      const page = makeFakePage({
        mainUrl: "https://careers.uchealth.org/jobs/123",
        iframes: {
          "iframe#talemetry_apply_iframe": "https://apply.talemetry.com/application/abc-123",
        },
        frames: Array.from({ length: 5 }, () => makeHangingFrame()) as never,
      });

      const timeoutMs = 2000;
      const evaluateTimeoutMs = 1000;
      const start = Date.now();
      let settledAt: number | null = null;
      const targetPromise = resolveFrameTarget(page as never, "iframe#talemetry_apply_iframe", {
        timeoutMs,
        pollMs: 100,
        evaluateTimeoutMs,
      }).then((resolved) => {
        // Captured inside the .then microtask that fires as soon as the
        // promise settles, mid-advance — reading Date.now() only after
        // `advanceTimersByTimeAsync` fully returns would report the entire
        // simulated window regardless of when resolution actually finished.
        settledAt = Date.now();
        return resolved;
      });

      await vi.advanceTimersByTimeAsync(timeoutMs + evaluateTimeoutMs + 500);
      const target = await targetPromise;

      expect(target.frame).toBeNull();
      expect(target.declaredFrameSelector).toBe("iframe#talemetry_apply_iframe");
      expect(settledAt).not.toBeNull();
      expect((settledAt as unknown as number) - start).toBeLessThanOrEqual(
        timeoutMs + evaluateTimeoutMs
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("still resolves an already-attached candidate frame at timeoutMs: 0, matching flow-runner's reresolveFrameTargetIfLost re-check", async () => {
    const page = makeFakePage({
      mainUrl: "https://careers.uchealth.org/jobs/123",
      iframes: {
        "iframe#talemetry_apply_iframe": "https://apply.talemetry.com/application/abc-123",
      },
      frames: [makeFakeFrame("https://apply.talemetry.com/application/abc-123")],
    });

    const target = await resolveFrameTarget(page as never, "iframe#talemetry_apply_iframe", {
      timeoutMs: 0,
      evaluateTimeoutMs: 100,
    });

    expect(target.frame).not.toBeNull();
    expect(target.frameSelector).toBe("iframe#talemetry_apply_iframe");
  });
});

describe("FrameTarget.evaluate/url: bounded against a never-settling underlying call", () => {
  it("rejects with a WatchdogTimeoutError within the evaluate budget, rather than blocking the caller, when the resolved child frame's evaluate never settles", async () => {
    // Resolves "location.href" (needed for resolveFrameTarget's own origin
    // match) but hangs on every other expression, modeling a frame that CDP
    // attached to but that wedges on a later evaluate call.
    const childFrame = {
      evaluate: (expr: unknown) =>
        expr === "location.href"
          ? Promise.resolve("https://apply.talemetry.com/application/abc-123")
          : new Promise(() => {}),
      locator: (selector: string) => ({ scope: "frame" as const, selector }),
    };
    const page = makeFakePage({
      mainUrl: "https://careers.uchealth.org/jobs/123",
      iframes: {
        "iframe#talemetry_apply_iframe": "https://apply.talemetry.com/application/abc-123",
      },
      frames: [childFrame as never],
    });

    const target = await resolveFrameTarget(page as never, "iframe#talemetry_apply_iframe", {
      evaluateTimeoutMs: 10,
    });
    expect(target.frame).toBe(childFrame);

    const start = Date.now();
    await expect(target.evaluate("document.title")).rejects.toMatchObject({
      name: "WatchdogTimeoutError",
    });
    expect(Date.now() - start).toBeLessThan(1000);
  });

  it("rejects url() within the evaluate budget when the resolved child frame's location.href evaluate never settles on a later call", async () => {
    // The first "location.href" call (resolution's own origin match)
    // resolves; every subsequent call (target.url()) hangs, modeling a
    // frame that attached fine but wedges on a later CDP round trip.
    let locationHrefCalls = 0;
    const childFrame = {
      evaluate: (expr: unknown) => {
        if (expr !== "location.href") return new Promise(() => {});
        locationHrefCalls += 1;
        return locationHrefCalls === 1
          ? Promise.resolve("https://apply.talemetry.com/application/abc-123")
          : new Promise(() => {});
      },
      locator: (selector: string) => ({ scope: "frame" as const, selector }),
    };
    const page = makeFakePage({
      mainUrl: "https://careers.uchealth.org/jobs/123",
      iframes: {
        "iframe#talemetry_apply_iframe": "https://apply.talemetry.com/application/abc-123",
      },
      frames: [childFrame as never],
    });

    const target = await resolveFrameTarget(page as never, "iframe#talemetry_apply_iframe", {
      evaluateTimeoutMs: 10,
    });
    expect(target.frame).toBe(childFrame);

    await expect(target.url()).rejects.toMatchObject({ name: "WatchdogTimeoutError" });
  });

  it("rejects a main-frame target's evaluate() within the evaluate budget when the underlying page.evaluate never settles", async () => {
    const page = {
      url: () => "https://careers.uchealth.org/jobs/123",
      title: async () => "main document title",
      evaluate: () => new Promise(() => {}),
      locator: (selector: string) => ({ scope: "main" as const, selector }),
      frames: () => [],
    };

    const target = await resolveFrameTarget(page as never, null);
    // Main-frame targets from the no-selector path default evaluateTimeoutMs
    // from the (mocked, small) config value.
    await expect(target.evaluate("document.title")).rejects.toMatchObject({
      name: "WatchdogTimeoutError",
    });
  });
});

describe("waitForChildFrameReady: bounded against a never-settling evaluate", () => {
  it("still resolves within its own timeout, instead of hanging, when the frame's document.readyState evaluate never settles", async () => {
    const target = makeFakeTarget(() => new Promise(() => {}));

    const start = Date.now();
    await expect(
      waitForChildFrameReady(target, { timeoutMs: 30, pollMs: 10, evaluateTimeoutMs: 8 })
    ).resolves.toBeUndefined();
    expect(Date.now() - start).toBeLessThan(1000);
  });
});
