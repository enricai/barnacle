import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  clickDeepLocatorCandidate,
  type DeepLocatorTimeoutOptions,
  resolveDeepLocatorCandidates,
} from "@/scraper/deep-locator-candidates";
import {
  type FakeDeepLocatorFrame,
  makeFakeDeepLocator,
  makeFakeFrameScan,
  registerDeepLocatorHopElements,
} from "@/scraper/deep-locator-fake";

/**
 * Builds a `FrameTarget` whose `evaluate` resolves against `frame`'s
 * registered hop via {@link makeFakeFrameScan} — the seam
 * `resolveDeepLocatorCandidates`'s batched-scan fast path reads through when
 * `timeoutOptions.frameTarget` is supplied directly (bypassing the internal
 * `resolveFrameTarget` re-resolution pass so these tests don't need a real
 * `Page.frames()`/`Page.evaluate()` surface). `evaluate` is wrapped in
 * `vi.fn` so a test can assert call count (one batched round-trip) directly.
 */
function makeFakeFrameTarget(
  frame: FakeDeepLocatorFrame,
  selector: string
): { frameTarget: FrameTarget; evaluateSpy: ReturnType<typeof vi.fn> } {
  const evaluateSpy = vi.fn(makeFakeFrameScan(frame, selector));
  const frameTarget: FrameTarget = {
    frame: {} as unknown as FrameTarget["frame"],
    frameSelector: selector,
    declaredFrameSelector: selector,
    evaluate: evaluateSpy as unknown as FrameTarget["evaluate"],
    locator: () => {
      throw new Error("locator() is not used by resolveDeepLocatorCandidates");
    },
    url: async () => "",
    title: async () => "",
  };
  return { frameTarget, evaluateSpy };
}

/**
 * Minimal fake `DeepLocatorDelegate`: `nth()` returns a scoped view over the
 * same backing `texts`/`clickSpy` so both the resolver's `textContent()`
 * reads and the actuator's `click()` land on the same delegate instance a
 * real `page.deepLocator(sel).nth(i)` chain would produce.
 */
function makeFakeDelegate(options: {
  count: number | (() => Promise<number>);
  texts?: string[];
  clickSpy?: (index: number) => Promise<void>;
  fillSpy?: (index: number, value: string) => Promise<void>;
  selectOptionSpy?: (index: number, values: string | string[]) => Promise<string[]>;
  rejectTextContentAt?: number[];
}) {
  const texts = options.texts ?? [];
  const clickSpy = options.clickSpy ?? vi.fn().mockResolvedValue(undefined);
  const fillSpy = options.fillSpy ?? vi.fn().mockResolvedValue(undefined);
  const selectOptionSpy = options.selectOptionSpy ?? vi.fn().mockResolvedValue([]);
  const rejectTextContentAt = options.rejectTextContentAt ?? [];
  const countFn =
    typeof options.count === "function" ? options.count : async () => options.count as number;
  return {
    count: countFn,
    nth: (index: number) => ({
      textContent: async () =>
        rejectTextContentAt.includes(index)
          ? Promise.reject(new Error("frame detached"))
          : (texts[index] ?? ""),
      click: async () => clickSpy(index),
      fill: async (value: string) => fillSpy(index, value),
      selectOption: async (values: string | string[]) => selectOptionSpy(index, values),
    }),
  };
}

function makeFakePage(delegate: ReturnType<typeof makeFakeDelegate>) {
  const deepLocatorSpy = vi.fn().mockReturnValue(delegate);
  return {
    page: { deepLocator: deepLocatorSpy },
    deepLocatorSpy,
  };
}

/**
 * Fake `DeepLocatorDelegate` that can wedge specific calls forever (never
 * resolving, never rejecting) — models the run-6 78-minute hang: a CDP
 * round-trip against a racy OOPIF frame that just never comes back. Distinct
 * from {@link makeFakeDelegate}'s `rejectTextContentAt` (which settles, just
 * with a rejection) and from `deep-locator-fake.ts`'s hang harness (which
 * hangs a method across every index of a hop, not one index in particular) —
 * per-candidate hang modeling needs a promise that specific indices never
 * settle while the rest resolve normally.
 */
function makeHangingDelegate(options: {
  count: number;
  texts?: string[];
  hangCountForever?: boolean;
  hangTextContentAt?: number[];
  hangClick?: boolean;
  clickSpy?: (index: number) => Promise<void>;
}) {
  const texts = options.texts ?? [];
  const hangTextContentAt = options.hangTextContentAt ?? [];
  const clickSpy = options.clickSpy ?? vi.fn().mockResolvedValue(undefined);
  return {
    count: async () => (options.hangCountForever ? new Promise<number>(() => {}) : options.count),
    nth: (index: number) => ({
      textContent: async () =>
        hangTextContentAt.includes(index) ? new Promise<string>(() => {}) : (texts[index] ?? ""),
      click: async () => (options.hangClick ? new Promise<void>(() => {}) : clickSpy(index)),
      fill: async () => {},
      selectOption: async () => [],
    }),
  };
}

describe("resolveDeepLocatorCandidates", () => {
  it("returns a candidate per matched element in delegate order, each deeplocator=-prefixed (not xpath=) and hop-composed, when no instruction is given", async () => {
    const delegate = makeFakeDelegate({ count: 2, texts: ["Manual Application", "Cancel"] });
    const { page, deepLocatorSpy } = makeFakePage(delegate);

    const candidates = await resolveDeepLocatorCandidates(
      // biome-ignore lint/suspicious/noExplicitAny: fake Page surface for the delegate contract under test
      page as any,
      "#apply_frame",
      "button"
    );

    expect(candidates).toEqual([
      {
        index: 0,
        selector: "deeplocator=#apply_frame >> button >> nth=0",
        accessibleText: "Manual Application",
      },
      {
        index: 1,
        selector: "deeplocator=#apply_frame >> button >> nth=1",
        accessibleText: "Cancel",
      },
    ]);
    expect(deepLocatorSpy).toHaveBeenCalledWith("#apply_frame >> button");
  });

  it("never emits an xpath=-prefixed selector, since hop notation is not evaluable via document.evaluate on the top-level document", async () => {
    const delegate = makeFakeDelegate({ count: 1, texts: ["Manual Application"] });
    const { page } = makeFakePage(delegate);

    const candidates = await resolveDeepLocatorCandidates(
      // biome-ignore lint/suspicious/noExplicitAny: fake Page surface for the delegate contract under test
      page as any,
      "#apply_frame",
      "*"
    );

    // biome-ignore lint/style/noNonNullAssertion: count() resolved 1, so index 0 is present
    expect(candidates[0]!.selector.startsWith("xpath=")).toBe(false);
  });

  it("returns [] when count() resolves to 0", async () => {
    const delegate = makeFakeDelegate({ count: 0 });
    const { page } = makeFakePage(delegate);

    const candidates = await resolveDeepLocatorCandidates(
      // biome-ignore lint/suspicious/noExplicitAny: fake Page surface for the delegate contract under test
      page as any,
      "#apply_frame",
      "button"
    );

    expect(candidates).toEqual([]);
  });

  it("returns [] rather than propagating when count() throws", async () => {
    const delegate = makeFakeDelegate({
      count: async () => {
        throw new Error("frame detached");
      },
    });
    const { page } = makeFakePage(delegate);

    const candidates = await resolveDeepLocatorCandidates(
      // biome-ignore lint/suspicious/noExplicitAny: fake Page surface for the delegate contract under test
      page as any,
      "#apply_frame",
      "button"
    );

    expect(candidates).toEqual([]);
  });

  it("degrades a per-candidate textContent() rejection to an empty accessibleText instead of throwing, preserving a candidate for every index", async () => {
    const delegate = makeFakeDelegate({
      count: 2,
      texts: [undefined as unknown as string, "Manual Application"],
      rejectTextContentAt: [0],
    });
    const { page } = makeFakePage(delegate);

    const candidates = await resolveDeepLocatorCandidates(
      // biome-ignore lint/suspicious/noExplicitAny: fake Page surface for the delegate contract under test
      page as any,
      "#apply_frame",
      "*"
    );

    expect(candidates).toEqual([
      {
        index: 0,
        selector: "deeplocator=#apply_frame >> * >> nth=0",
        accessibleText: "",
      },
      {
        index: 1,
        selector: "deeplocator=#apply_frame >> * >> nth=1",
        accessibleText: "Manual Application",
      },
    ]);
  });

  it("ranks a textContent()-rejected candidate at score 0, below a genuine instruction match, rather than dropping or promoting it", async () => {
    const delegate = makeFakeDelegate({
      count: 2,
      texts: [undefined as unknown as string, "Manual Application"],
      rejectTextContentAt: [0],
    });
    const { page } = makeFakePage(delegate);

    const candidates = await resolveDeepLocatorCandidates(
      // biome-ignore lint/suspicious/noExplicitAny: fake Page surface for the delegate contract under test
      page as any,
      "#apply_frame",
      "*",
      "click the 'Manual Application' button"
    );

    expect(candidates).toHaveLength(2);
    // biome-ignore lint/style/noNonNullAssertion: 2 candidates were registered, so index 0 is present
    expect(candidates[0]!.accessibleText).toBe("Manual Application");
    // biome-ignore lint/style/noNonNullAssertion: 2 candidates were registered, so index 1 is present
    expect(candidates[1]!.accessibleText).toBe("");
  });

  it("composes an unscoped selector unchanged when frameSelector is null (buildHopSelector passthrough)", async () => {
    const delegate = makeFakeDelegate({ count: 1, texts: ["Submit"] });
    const { page, deepLocatorSpy } = makeFakePage(delegate);

    // biome-ignore lint/suspicious/noExplicitAny: fake Page surface for the delegate contract under test
    await resolveDeepLocatorCandidates(page as any, null, "button[type=submit]");

    expect(deepLocatorSpy).toHaveBeenCalledWith("button[type=submit]");
  });

  describe("instruction-relevance ranking", () => {
    const ACCEPTANCE_INSTRUCTION =
      "In the application widget, click the 'Manual Application' button to skip the resume-upload flow entirely. Do NOT click 'Upload a Resume/CV', 'Use LinkedIn Profile', 'Upload From Dropbox', or 'Upload From OneDrive'.";

    function makeAcceptanceScenarioPage() {
      const frame: FakeDeepLocatorFrame = new Map();
      registerDeepLocatorHopElements(frame, "#apply_frame >> *", [
        "",
        "Upload a Resume/CV",
        "Use LinkedIn Profile",
        "Manual Application",
      ]);
      return { deepLocator: makeFakeDeepLocator(frame) } as unknown as {
        deepLocator: (selector: string) => ReturnType<typeof makeFakeDeepLocator>;
      };
    }

    it("ranks the instruction's intended control first even though it is last in DOM order, and does not rank any negated decoy above it", async () => {
      const page = makeAcceptanceScenarioPage();

      const candidates = await resolveDeepLocatorCandidates(
        // biome-ignore lint/suspicious/noExplicitAny: fake Page surface for the delegate contract under test
        page as any,
        "#apply_frame",
        "*",
        ACCEPTANCE_INSTRUCTION
      );

      // biome-ignore lint/style/noNonNullAssertion: 4 candidates were registered, so index 0 is present
      expect(candidates[0]!.accessibleText).toBe("Manual Application");
      const manualApplicationRank = candidates.findIndex(
        (c) => c.accessibleText === "Manual Application"
      );
      const negatedTexts = ["Upload a Resume/CV", "Use LinkedIn Profile"];
      for (const negatedText of negatedTexts) {
        const negatedRank = candidates.findIndex((c) => c.accessibleText === negatedText);
        expect(negatedRank).toBeGreaterThan(manualApplicationRank);
      }
    });

    it("never ranks a candidate with no accessible text above one whose text matches the instruction", async () => {
      const page = makeAcceptanceScenarioPage();

      const candidates = await resolveDeepLocatorCandidates(
        // biome-ignore lint/suspicious/noExplicitAny: fake Page surface for the delegate contract under test
        page as any,
        "#apply_frame",
        "*",
        ACCEPTANCE_INSTRUCTION
      );

      const emptyTextRank = candidates.findIndex((c) => c.accessibleText === "");
      const manualApplicationRank = candidates.findIndex(
        (c) => c.accessibleText === "Manual Application"
      );
      expect(emptyTextRank).toBeGreaterThan(manualApplicationRank);
    });

    it("preserves DOM order for candidates tied on relevance (no phrases match either)", async () => {
      const delegate = makeFakeDelegate({ count: 2, texts: ["Foo", "Bar"] });
      const { page } = makeFakePage(delegate);

      const candidates = await resolveDeepLocatorCandidates(
        // biome-ignore lint/suspicious/noExplicitAny: fake Page surface for the delegate contract under test
        page as any,
        "#apply_frame",
        "*",
        "click the 'Something Else' button"
      );

      expect(candidates.map((c) => c.accessibleText)).toEqual(["Foo", "Bar"]);
    });

    it("falls back to delegate order when the instruction has no quoted phrases", async () => {
      const delegate = makeFakeDelegate({ count: 2, texts: ["Manual Application", "Cancel"] });
      const { page } = makeFakePage(delegate);

      const candidates = await resolveDeepLocatorCandidates(
        // biome-ignore lint/suspicious/noExplicitAny: fake Page surface for the delegate contract under test
        page as any,
        "#apply_frame",
        "*",
        "click the manual application button"
      );

      expect(candidates.map((c) => c.accessibleText)).toEqual(["Manual Application", "Cancel"]);
    });
  });
});

describe("resolveDeepLocatorCandidates batched frame-scoped scan", () => {
  beforeEach(() => {
    loggerStub.warn.mockClear();
  });

  it("resolves a 371-candidate frame with exactly one evaluate call and zero delegate count()/nth() calls, within budget", async () => {
    const frame: FakeDeepLocatorFrame = new Map();
    const elements = Array.from({ length: 371 }, (_, index) =>
      index === 200 ? "Manual Application" : `node-${index}`
    );
    registerDeepLocatorHopElements(frame, "#apply_frame >> *", elements);
    const { frameTarget, evaluateSpy } = makeFakeFrameTarget(frame, "#apply_frame >> *");
    const countSpy = vi.fn();
    const nthSpy = vi.fn();
    const deepLocatorSpy = vi.fn().mockReturnValue({ count: countSpy, nth: nthSpy });

    const candidates = await resolveDeepLocatorCandidates(
      // biome-ignore lint/suspicious/noExplicitAny: fake Page surface for the delegate contract under test
      { deepLocator: deepLocatorSpy } as any,
      "#apply_frame",
      "*",
      null,
      { frameTarget }
    );

    expect(candidates).toHaveLength(371);
    expect(evaluateSpy).toHaveBeenCalledTimes(1);
    expect(countSpy).not.toHaveBeenCalled();
    expect(nthSpy).not.toHaveBeenCalled();
    expect(loggerStub.warn).not.toHaveBeenCalledWith(
      expect.stringContaining("aborted after exceeding")
    );
  });

  it("keeps each candidate's index aligned with clickDeepLocatorCandidate's nth(), even after visibility filtering drops an earlier index", async () => {
    const frame: FakeDeepLocatorFrame = new Map();
    const hop = registerDeepLocatorHopElements(frame, "#apply_frame >> *", [
      { text: "Hidden Decoy", visible: false },
      { text: "Manual Application", visible: true },
    ]);
    const { frameTarget } = makeFakeFrameTarget(frame, "#apply_frame >> *");
    const page = { deepLocator: makeFakeDeepLocator(frame) };
    const timeoutOptions: DeepLocatorTimeoutOptions = { frameTarget };

    const candidates = await resolveDeepLocatorCandidates(
      // biome-ignore lint/suspicious/noExplicitAny: fake Page surface for the delegate contract under test
      page as any,
      "#apply_frame",
      "*",
      null,
      timeoutOptions
    );

    expect(candidates).toEqual([
      {
        index: 1,
        selector: "deeplocator=#apply_frame >> * >> nth=1",
        accessibleText: "Manual Application",
      },
    ]);

    await clickDeepLocatorCandidate(
      // biome-ignore lint/suspicious/noExplicitAny: fake Page surface for the delegate contract under test
      page as any,
      "#apply_frame",
      "*",
      // biome-ignore lint/style/noNonNullAssertion: exactly one candidate survived filtering
      candidates[0]!.index,
      timeoutOptions
    );

    expect(hop.elements[1]?.clicks).toBe(1);
    expect(hop.elements[0]?.clicks).toBe(0);
  });

  it("drops visible:false entries while keeping laid-out siblings, ranking a visible instruction match above a visible non-match", async () => {
    const frame: FakeDeepLocatorFrame = new Map();
    registerDeepLocatorHopElements(frame, "#apply_frame >> *", [
      { text: "Manual Application", visible: false },
      { text: "Cancel", visible: true },
      { text: "Manual Application", visible: true },
    ]);
    const { frameTarget } = makeFakeFrameTarget(frame, "#apply_frame >> *");
    const page = { deepLocator: makeFakeDeepLocator(frame) };

    const candidates = await resolveDeepLocatorCandidates(
      // biome-ignore lint/suspicious/noExplicitAny: fake Page surface for the delegate contract under test
      page as any,
      "#apply_frame",
      "*",
      "click the 'Manual Application' button",
      { frameTarget }
    );

    expect(candidates.map((c) => ({ index: c.index, accessibleText: c.accessibleText }))).toEqual([
      { index: 2, accessibleText: "Manual Application" },
      { index: 1, accessibleText: "Cancel" },
    ]);
    expect(loggerStub.warn).toHaveBeenCalledWith(
      expect.stringContaining("dropped 1 unrendered candidate")
    );
  });

  it("falls back to the legacy per-candidate loop when the frame seam's evaluate rejects", async () => {
    const delegate = makeFakeDelegate({ count: 2, texts: ["A", "B"] });
    const { page } = makeFakePage(delegate);
    const frameTarget: FrameTarget = {
      frame: {} as unknown as FrameTarget["frame"],
      frameSelector: "#f",
      declaredFrameSelector: "#f",
      evaluate: vi.fn().mockRejectedValue(new Error("evaluate wedged")),
      locator: () => {
        throw new Error("locator() is not used by resolveDeepLocatorCandidates");
      },
      url: async () => "",
      title: async () => "",
    };

    const candidates = await resolveDeepLocatorCandidates(
      // biome-ignore lint/suspicious/noExplicitAny: fake Page surface for the delegate contract under test
      page as any,
      "#f",
      "*",
      null,
      { frameTarget }
    );

    expect(candidates.map((c) => c.accessibleText)).toEqual(["A", "B"]);
    expect(loggerStub.warn).toHaveBeenCalledWith(
      expect.stringContaining("deepLocator batched scan for")
    );
  });

  it("falls back to the legacy per-candidate loop when the frame seam returns a non-conforming payload", async () => {
    const delegate = makeFakeDelegate({ count: 1, texts: ["Manual Application"] });
    const { page } = makeFakePage(delegate);
    const frameTarget: FrameTarget = {
      frame: {} as unknown as FrameTarget["frame"],
      frameSelector: "#f",
      declaredFrameSelector: "#f",
      // biome-ignore lint/suspicious/noExplicitAny: deliberately non-conforming payload shape under test
      evaluate: vi.fn().mockResolvedValue([{ nope: true }] as any),
      locator: () => {
        throw new Error("locator() is not used by resolveDeepLocatorCandidates");
      },
      url: async () => "",
      title: async () => "",
    };

    const candidates = await resolveDeepLocatorCandidates(
      // biome-ignore lint/suspicious/noExplicitAny: fake Page surface for the delegate contract under test
      page as any,
      "#f",
      "*",
      null,
      { frameTarget }
    );

    expect(candidates.map((c) => c.accessibleText)).toEqual(["Manual Application"]);
    expect(loggerStub.warn).toHaveBeenCalledWith(expect.stringContaining("non-conforming payload"));
  });

  it("falls back to the legacy per-candidate loop when no frameTarget is supplied and frameSelector is null", async () => {
    const delegate = makeFakeDelegate({ count: 1, texts: ["Submit"] });
    const { page } = makeFakePage(delegate);

    // biome-ignore lint/suspicious/noExplicitAny: fake Page surface for the delegate contract under test
    const candidates = await resolveDeepLocatorCandidates(page as any, null, "button[type=submit]");

    expect(candidates.map((c) => c.accessibleText)).toEqual(["Submit"]);
  });
});

describe("clickDeepLocatorCandidate", () => {
  it("invokes click() on the delegate nth() of the selected candidate index", async () => {
    const clickSpy = vi.fn().mockResolvedValue(undefined);
    const delegate = makeFakeDelegate({
      count: 2,
      texts: ["Manual Application", "Cancel"],
      clickSpy,
    });
    const { page, deepLocatorSpy } = makeFakePage(delegate);

    await clickDeepLocatorCandidate(
      // biome-ignore lint/suspicious/noExplicitAny: fake Page surface for the delegate contract under test
      page as any,
      "#apply_frame",
      "button",
      0
    );

    expect(deepLocatorSpy).toHaveBeenCalledWith("#apply_frame >> button");
    expect(clickSpy).toHaveBeenCalledWith(0);
  });

  it("propagates a click() rejection rather than swallowing it", async () => {
    const delegate = makeFakeDelegate({
      count: 1,
      texts: ["Manual Application"],
      clickSpy: vi.fn().mockRejectedValue(new Error("element not attached")),
    });
    const { page } = makeFakePage(delegate);

    await expect(
      // biome-ignore lint/suspicious/noExplicitAny: fake Page surface for the delegate contract under test
      clickDeepLocatorCandidate(page as any, "#apply_frame", "button", 0)
    ).rejects.toThrow("element not attached");
  });
});

// fillDeepLocatorCandidate/selectDeepLocatorCandidateOption moved to
// deep-locator-actuate.ts (see this file's module docblock near the bottom);
// their tests moved with them to deep-locator-actuate.test.ts.

describe("watchdog-guarded awaits (deepLocator-direct hang bug)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    loggerStub.warn.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("a never-settling count() resolves resolveDeepLocatorCandidates to [] within the call-timeout budget, with a warn", async () => {
    const delegate = makeHangingDelegate({ count: 0, hangCountForever: true });
    const { page } = makeFakePage(delegate);

    const promise = resolveDeepLocatorCandidates(
      // biome-ignore lint/suspicious/noExplicitAny: fake Page surface for the delegate contract under test
      page as any,
      "#apply_frame",
      "*",
      null,
      { callTimeoutMs: 50 }
    );

    await vi.advanceTimersByTimeAsync(50);
    await expect(promise).resolves.toEqual([]);
    expect(loggerStub.warn).toHaveBeenCalledWith(
      expect.stringContaining("deepLocator count() threw")
    );
  });

  it("a never-settling count() resolves resolveDeepLocatorCandidates to [] at the 10s default when timeoutOptions is omitted", async () => {
    const delegate = makeHangingDelegate({ count: 0, hangCountForever: true });
    const { page } = makeFakePage(delegate);

    const promise = resolveDeepLocatorCandidates(
      // biome-ignore lint/suspicious/noExplicitAny: fake Page surface for the delegate contract under test
      page as any,
      "#apply_frame",
      "*"
    );

    await vi.advanceTimersByTimeAsync(10_000);
    await expect(promise).resolves.toEqual([]);
  });

  it("a never-settling per-candidate textContent() degrades only that candidate to an empty accessibleText, still returning every other candidate", async () => {
    const delegate = makeHangingDelegate({
      count: 3,
      texts: ["Container", "Manual Application", "Cancel"],
      hangTextContentAt: [1],
    });
    const { page } = makeFakePage(delegate);

    const promise = resolveDeepLocatorCandidates(
      // biome-ignore lint/suspicious/noExplicitAny: fake Page surface for the delegate contract under test
      page as any,
      "#apply_frame",
      "*",
      null,
      { callTimeoutMs: 50, enumerationBudgetMs: 10_000 }
    );

    await vi.advanceTimersByTimeAsync(50);
    const candidates = await promise;

    expect(candidates.map((c) => c.accessibleText)).toEqual(["Container", "", "Cancel"]);
  });

  it("a never-settling click() rejects clickDeepLocatorCandidate within the call-timeout budget instead of hanging the caller", async () => {
    const delegate = makeHangingDelegate({
      count: 1,
      texts: ["Manual Application"],
      hangClick: true,
    });
    const { page } = makeFakePage(delegate);

    const promise = clickDeepLocatorCandidate(
      // biome-ignore lint/suspicious/noExplicitAny: fake Page surface for the delegate contract under test
      page as any,
      "#apply_frame",
      "button",
      0,
      { callTimeoutMs: 50 }
    );
    const assertion = expect(promise).rejects.toMatchObject({ name: "WatchdogTimeoutError" });

    await vi.advanceTimersByTimeAsync(50);
    await assertion;
  });

  it("a never-settling click() rejects clickDeepLocatorCandidate at the 10s default when timeoutOptions is omitted", async () => {
    const delegate = makeHangingDelegate({
      count: 1,
      texts: ["Manual Application"],
      hangClick: true,
    });
    const { page } = makeFakePage(delegate);

    const promise = clickDeepLocatorCandidate(
      // biome-ignore lint/suspicious/noExplicitAny: fake Page surface for the delegate contract under test
      page as any,
      "#apply_frame",
      "button",
      0
    );
    const assertion = expect(promise).rejects.toMatchObject({ name: "WatchdogTimeoutError" });

    await vi.advanceTimersByTimeAsync(10_000);
    await assertion;
  });

  // fillDeepLocatorCandidate/selectDeepLocatorCandidateOption's watchdog
  // coverage moved to deep-locator-actuate.test.ts along with the functions.

  it("enumerating a hop with many slow-but-settling elements aborts on the total enumeration budget, returning only the candidates resolved before the deadline", async () => {
    const perCandidateDelayMs = 20;
    const texts = ["A", "B", "C", "D", "E"];
    const delegate = {
      count: async () => texts.length,
      nth: (index: number) => ({
        textContent: () =>
          new Promise<string>((resolve) => {
            setTimeout(() => resolve(texts[index] ?? ""), perCandidateDelayMs);
          }),
        click: async () => {},
        fill: async () => {},
        selectOption: async () => [],
      }),
    };
    const { page } = makeFakePage(delegate);

    const promise = resolveDeepLocatorCandidates(
      // biome-ignore lint/suspicious/noExplicitAny: fake Page surface for the delegate contract under test
      page as any,
      "#apply_frame",
      "*",
      null,
      { callTimeoutMs: 10_000, enumerationBudgetMs: 35 }
    );

    await vi.advanceTimersByTimeAsync(200);
    const candidates = await promise;

    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates.length).toBeLessThan(texts.length);
    expect(candidates.map((c) => c.accessibleText)).toEqual(texts.slice(0, candidates.length));
    expect(loggerStub.warn).toHaveBeenCalledWith(
      expect.stringContaining("deepLocator enumeration")
    );
  });
});
