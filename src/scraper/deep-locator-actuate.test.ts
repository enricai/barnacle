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
  fillDeepLocatorCandidate,
  selectDeepLocatorCandidateOption,
} from "@/scraper/deep-locator-actuate";
import {
  type FakeDeepLocatorFrame,
  makeFakeDeepLocator,
  registerDeepLocatorHangingHop,
  registerDeepLocatorHopElements,
  registerDeepLocatorHopLatency,
} from "@/scraper/deep-locator-fake";

const FRAME_SELECTOR = "#apply_frame";

function makeFakePage(frame: FakeDeepLocatorFrame) {
  return { deepLocator: makeFakeDeepLocator(frame) };
}

/** Builds a `FrameTarget` whose `evaluate` is a bare spy a test configures per scenario — mirrors `deep-locator-candidates.click-throughput.test.ts`'s helper of the same shape. */
function makeFakeFrameTarget(evaluateImpl: (...args: unknown[]) => Promise<unknown>): {
  frameTarget: FrameTarget;
  evaluateSpy: ReturnType<typeof vi.fn>;
} {
  const evaluateSpy = vi.fn(evaluateImpl);
  const frameTarget: FrameTarget = {
    frame: {} as unknown as FrameTarget["frame"],
    frameSelector: FRAME_SELECTOR,
    declaredFrameSelector: FRAME_SELECTOR,
    evaluate: evaluateSpy as unknown as FrameTarget["evaluate"],
    locator: () => {
      throw new Error(
        "locator() is not used by fillDeepLocatorCandidate/selectDeepLocatorCandidateOption"
      );
    },
    url: async () => "",
    title: async () => "",
  };
  return { frameTarget, evaluateSpy };
}

describe("fillDeepLocatorCandidate", () => {
  it("writes the value and returns true when inputValue() reads it back", async () => {
    const frame: FakeDeepLocatorFrame = new Map();
    registerDeepLocatorHopElements(frame, `${FRAME_SELECTOR} >> input`, ["", ""]);
    const page = makeFakePage(frame);

    const result = await fillDeepLocatorCandidate(
      // biome-ignore lint/suspicious/noExplicitAny: fake Page surface for the delegate contract under test
      page as any,
      FRAME_SELECTOR,
      "input",
      1,
      "Ada"
    );

    expect(result).toBe(true);
    expect(frame.get(`${FRAME_SELECTOR} >> input`)?.elements[1]?.filledWith).toBe("Ada");
  });

  it("returns false, never throws, when the read-back disagrees with what was written", async () => {
    const frame: FakeDeepLocatorFrame = new Map();
    const hop = registerDeepLocatorHopElements(frame, `${FRAME_SELECTOR} >> input`, [""]);
    const element = hop.elements[0];
    if (!element) throw new Error("test setup: expected a registered element");
    element.readBackValue = "";
    const page = makeFakePage(frame);

    const result = await fillDeepLocatorCandidate(
      // biome-ignore lint/suspicious/noExplicitAny: fake Page surface for the delegate contract under test
      page as any,
      FRAME_SELECTOR,
      "input",
      0,
      "Ada"
    );

    expect(result).toBe(false);
  });

  it("returns false, never throws, when the delegate rejects the fill", async () => {
    const frame: FakeDeepLocatorFrame = new Map();
    registerDeepLocatorHopElements(frame, `${FRAME_SELECTOR} >> input`, ["existing"]);
    const page = makeFakePage(frame);

    const result = await fillDeepLocatorCandidate(
      // biome-ignore lint/suspicious/noExplicitAny: fake Page surface for the delegate contract under test
      page as any,
      FRAME_SELECTOR,
      "input",
      1,
      "Ada"
    );

    expect(result).toBe(false);
  });
});

describe("selectDeepLocatorCandidateOption", () => {
  it("selects the option and returns true when inputValue() reads it back, same as fillDeepLocatorCandidate", async () => {
    const frame: FakeDeepLocatorFrame = new Map();
    registerDeepLocatorHopElements(frame, `${FRAME_SELECTOR} >> select`, [""]);
    const page = makeFakePage(frame);

    const result = await selectDeepLocatorCandidateOption(
      // biome-ignore lint/suspicious/noExplicitAny: fake Page surface for the delegate contract under test
      page as any,
      FRAME_SELECTOR,
      "select",
      0,
      "US"
    );

    expect(result).toBe(true);
    expect(frame.get(`${FRAME_SELECTOR} >> select`)?.selectedWith).toEqual(["US"]);
  });

  it("returns false, never throws, when the read-back disagrees with the selected option", async () => {
    const frame: FakeDeepLocatorFrame = new Map();
    const hop = registerDeepLocatorHopElements(frame, `${FRAME_SELECTOR} >> select`, [""]);
    const element = hop.elements[0];
    if (!element) throw new Error("test setup: expected a registered element");
    element.readBackValue = "CA";
    const page = makeFakePage(frame);

    const result = await selectDeepLocatorCandidateOption(
      // biome-ignore lint/suspicious/noExplicitAny: fake Page surface for the delegate contract under test
      page as any,
      FRAME_SELECTOR,
      "select",
      0,
      "US"
    );

    expect(result).toBe(false);
  });

  it("returns false, never throws, when the delegate rejects the select", async () => {
    const frame: FakeDeepLocatorFrame = new Map();
    const page = makeFakePage(frame);

    const result = await selectDeepLocatorCandidateOption(
      // biome-ignore lint/suspicious/noExplicitAny: fake Page surface for the delegate contract under test
      page as any,
      FRAME_SELECTOR,
      "select",
      0,
      "US"
    );

    expect(result).toBe(false);
  });
});

describe("fillDeepLocatorCandidate batched frame-scoped fill", () => {
  beforeEach(() => {
    loggerStub.warn.mockClear();
  });

  it("returns true after exactly two evaluate calls (write + stuck-confirm) and zero delegate calls when the frame seam resolves a matching write that stays stuck", async () => {
    const frame: FakeDeepLocatorFrame = new Map();
    registerDeepLocatorHopElements(frame, `${FRAME_SELECTOR} >> input`, ["", ""]);
    const deepLocatorSpy = vi.fn(makeFakeDeepLocator(frame));
    const page = { deepLocator: deepLocatorSpy };
    const { frameTarget, evaluateSpy } = makeFakeFrameTarget(async (expression: unknown) =>
      typeof expression === "string" &&
      expression.includes("querySelectorAll") &&
      !expression.includes("dispatchEvent")
        ? { value: "Ada" }
        : { written: true, readBack: "Ada" }
    );

    const result = await fillDeepLocatorCandidate(
      // biome-ignore lint/suspicious/noExplicitAny: fake Page surface for the delegate contract under test
      page as any,
      FRAME_SELECTOR,
      "input",
      1,
      "Ada",
      { frameTarget }
    );

    expect(result).toBe(true);
    expect(evaluateSpy).toHaveBeenCalledTimes(2);
    expect(deepLocatorSpy).not.toHaveBeenCalled();
  });

  it("falls back to the delegate when the write's inline readBack matches but the stuck-confirm re-check later disagrees (a controlled component reverting on a later tick)", async () => {
    const frame: FakeDeepLocatorFrame = new Map();
    registerDeepLocatorHopElements(frame, `${FRAME_SELECTOR} >> input`, ["", ""]);
    const deepLocatorSpy = vi.fn(makeFakeDeepLocator(frame));
    const page = { deepLocator: deepLocatorSpy };
    const { frameTarget, evaluateSpy } = makeFakeFrameTarget(async (expression: unknown) =>
      typeof expression === "string" &&
      expression.includes("querySelectorAll") &&
      !expression.includes("dispatchEvent")
        ? { value: "" }
        : { written: true, readBack: "Ada" }
    );

    const result = await fillDeepLocatorCandidate(
      // biome-ignore lint/suspicious/noExplicitAny: fake Page surface for the delegate contract under test
      page as any,
      FRAME_SELECTOR,
      "input",
      1,
      "Ada",
      { frameTarget }
    );

    expect(result).toBe(true);
    expect(evaluateSpy).toHaveBeenCalledTimes(2);
    expect(deepLocatorSpy).toHaveBeenCalled();
    expect(frame.get(`${FRAME_SELECTOR} >> input`)?.elements[1]?.filledWith).toBe("Ada");
  });

  it("falls back to the delegate, rather than returning false outright, when the frame seam's write read-back disagrees with what was asked for", async () => {
    const frame: FakeDeepLocatorFrame = new Map();
    registerDeepLocatorHopElements(frame, `${FRAME_SELECTOR} >> input`, ["", ""]);
    const deepLocatorSpy = vi.fn(makeFakeDeepLocator(frame));
    const page = { deepLocator: deepLocatorSpy };
    const { frameTarget } = makeFakeFrameTarget(async () => ({
      written: true,
      readBack: "Not Ada",
    }));

    const result = await fillDeepLocatorCandidate(
      // biome-ignore lint/suspicious/noExplicitAny: fake Page surface for the delegate contract under test
      page as any,
      FRAME_SELECTOR,
      "input",
      1,
      "Ada",
      { frameTarget }
    );

    expect(result).toBe(true);
    expect(deepLocatorSpy).toHaveBeenCalled();
  });

  it("resolves false without a delegate call when the frame seam reports the candidate not-actionable", async () => {
    const deepLocatorSpy = vi.fn();
    const page = { deepLocator: deepLocatorSpy };
    const { frameTarget } = makeFakeFrameTarget(async () => ({
      written: false,
      reason: "not-actionable",
    }));

    const result = await fillDeepLocatorCandidate(
      // biome-ignore lint/suspicious/noExplicitAny: fake Page surface for the delegate contract under test
      page as any,
      FRAME_SELECTOR,
      "input",
      0,
      "Ada",
      { frameTarget }
    );

    expect(result).toBe(false);
    expect(deepLocatorSpy).not.toHaveBeenCalled();
  });

  it("degrades to the delegate path and still returns true when the frame seam's evaluate rejects", async () => {
    const frame: FakeDeepLocatorFrame = new Map();
    registerDeepLocatorHopElements(frame, `${FRAME_SELECTOR} >> input`, ["", ""]);
    const page = makeFakePage(frame);
    const { frameTarget } = makeFakeFrameTarget(async () => {
      throw new Error("evaluate wedged");
    });

    const result = await fillDeepLocatorCandidate(
      // biome-ignore lint/suspicious/noExplicitAny: fake Page surface for the delegate contract under test
      page as any,
      FRAME_SELECTOR,
      "input",
      1,
      "Ada",
      { frameTarget }
    );

    expect(result).toBe(true);
    expect(frame.get(`${FRAME_SELECTOR} >> input`)?.elements[1]?.filledWith).toBe("Ada");
    expect(loggerStub.warn).toHaveBeenCalledWith(
      expect.stringContaining("deepLocator batched fill for")
    );
  });

  it("degrades to the delegate path and still returns true when the frame seam resolves a non-conforming payload", async () => {
    const frame: FakeDeepLocatorFrame = new Map();
    registerDeepLocatorHopElements(frame, `${FRAME_SELECTOR} >> input`, ["", ""]);
    const page = makeFakePage(frame);
    // biome-ignore lint/suspicious/noExplicitAny: deliberately non-conforming payload shape under test
    const { frameTarget } = makeFakeFrameTarget(async () => ({ nope: true }) as any);

    const result = await fillDeepLocatorCandidate(
      // biome-ignore lint/suspicious/noExplicitAny: fake Page surface for the delegate contract under test
      page as any,
      FRAME_SELECTOR,
      "input",
      1,
      "Ada",
      { frameTarget }
    );

    expect(result).toBe(true);
    expect(frame.get(`${FRAME_SELECTOR} >> input`)?.elements[1]?.filledWith).toBe("Ada");
    expect(loggerStub.warn).toHaveBeenCalledWith(expect.stringContaining("non-conforming payload"));
  });

  it("degrades to the delegate path when the frame seam reports a stale out-of-range index", async () => {
    const frame: FakeDeepLocatorFrame = new Map();
    registerDeepLocatorHopElements(frame, `${FRAME_SELECTOR} >> input`, ["", ""]);
    const page = makeFakePage(frame);
    const { frameTarget } = makeFakeFrameTarget(async () => ({
      written: false,
      reason: "out-of-range",
    }));

    const result = await fillDeepLocatorCandidate(
      // biome-ignore lint/suspicious/noExplicitAny: fake Page surface for the delegate contract under test
      page as any,
      FRAME_SELECTOR,
      "input",
      1,
      "Ada",
      { frameTarget }
    );

    expect(result).toBe(true);
    expect(frame.get(`${FRAME_SELECTOR} >> input`)?.elements[1]?.filledWith).toBe("Ada");
  });

  it("with no frameTarget supplied and no evaluate seam resolvable, behaves byte-identically to the pre-batched delegate path", async () => {
    const frame: FakeDeepLocatorFrame = new Map();
    registerDeepLocatorHopElements(frame, `${FRAME_SELECTOR} >> input`, ["", ""]);
    const deepLocatorSpy = vi.fn(makeFakeDeepLocator(frame));
    const page = { deepLocator: deepLocatorSpy };

    const result = await fillDeepLocatorCandidate(
      // biome-ignore lint/suspicious/noExplicitAny: fake Page surface for the delegate contract under test
      page as any,
      FRAME_SELECTOR,
      "input",
      1,
      "Ada"
    );

    expect(result).toBe(true);
    expect(deepLocatorSpy).toHaveBeenCalledWith(`${FRAME_SELECTOR} >> input`);
    expect(frame.get(`${FRAME_SELECTOR} >> input`)?.elements[1]?.filledWith).toBe("Ada");
    expect(loggerStub.warn).not.toHaveBeenCalled();
  });
});

describe("selectDeepLocatorCandidateOption batched frame-scoped select", () => {
  beforeEach(() => {
    loggerStub.warn.mockClear();
  });

  it("returns true after exactly two evaluate calls (write + stuck-confirm) and zero delegate calls when the frame seam resolves a matching write that stays stuck", async () => {
    const frame: FakeDeepLocatorFrame = new Map();
    registerDeepLocatorHopElements(frame, `${FRAME_SELECTOR} >> select`, [""]);
    const deepLocatorSpy = vi.fn(makeFakeDeepLocator(frame));
    const page = { deepLocator: deepLocatorSpy };
    const { frameTarget, evaluateSpy } = makeFakeFrameTarget(async (expression: unknown) =>
      typeof expression === "string" &&
      expression.includes("querySelectorAll") &&
      !expression.includes("dispatchEvent")
        ? { value: "US" }
        : { written: true, readBack: "US" }
    );

    const result = await selectDeepLocatorCandidateOption(
      // biome-ignore lint/suspicious/noExplicitAny: fake Page surface for the delegate contract under test
      page as any,
      FRAME_SELECTOR,
      "select",
      0,
      "US",
      { frameTarget }
    );

    expect(result).toBe(true);
    expect(evaluateSpy).toHaveBeenCalledTimes(2);
    expect(deepLocatorSpy).not.toHaveBeenCalled();
  });

  it("returns true, without a delegate call, when the frame seam matched by label and its readBack (the option's value) differs from the label passed in, and the stuck-confirm re-check agrees with that readBack", async () => {
    const deepLocatorSpy = vi.fn();
    const page = { deepLocator: deepLocatorSpy };
    const { frameTarget, evaluateSpy } = makeFakeFrameTarget(async (expression: unknown) =>
      typeof expression === "string" &&
      expression.includes("querySelectorAll") &&
      !expression.includes("dispatchEvent")
        ? { value: "US" }
        : { written: true, readBack: "US" }
    );

    const result = await selectDeepLocatorCandidateOption(
      // biome-ignore lint/suspicious/noExplicitAny: fake Page surface for the delegate contract under test
      page as any,
      FRAME_SELECTOR,
      "select",
      0,
      "United States",
      { frameTarget }
    );

    expect(result).toBe(true);
    expect(evaluateSpy).toHaveBeenCalledTimes(2);
    expect(deepLocatorSpy).not.toHaveBeenCalled();
  });

  it("resolves false without a delegate call when the frame seam reports the candidate not-actionable", async () => {
    const deepLocatorSpy = vi.fn();
    const page = { deepLocator: deepLocatorSpy };
    const { frameTarget } = makeFakeFrameTarget(async () => ({
      written: false,
      reason: "not-actionable",
    }));

    const result = await selectDeepLocatorCandidateOption(
      // biome-ignore lint/suspicious/noExplicitAny: fake Page surface for the delegate contract under test
      page as any,
      FRAME_SELECTOR,
      "select",
      0,
      "US",
      { frameTarget }
    );

    expect(result).toBe(false);
    expect(deepLocatorSpy).not.toHaveBeenCalled();
  });

  it("degrades to the delegate path and still returns true when the frame seam's evaluate rejects", async () => {
    const frame: FakeDeepLocatorFrame = new Map();
    registerDeepLocatorHopElements(frame, `${FRAME_SELECTOR} >> select`, [""]);
    const page = makeFakePage(frame);
    const { frameTarget } = makeFakeFrameTarget(async () => {
      throw new Error("evaluate wedged");
    });

    const result = await selectDeepLocatorCandidateOption(
      // biome-ignore lint/suspicious/noExplicitAny: fake Page surface for the delegate contract under test
      page as any,
      FRAME_SELECTOR,
      "select",
      0,
      "US",
      { frameTarget }
    );

    expect(result).toBe(true);
    expect(frame.get(`${FRAME_SELECTOR} >> select`)?.selectedWith).toEqual(["US"]);
    expect(loggerStub.warn).toHaveBeenCalledWith(
      expect.stringContaining("deepLocator batched select for")
    );
  });

  it("degrades to the delegate path and still returns true when the frame seam resolves a non-conforming payload", async () => {
    const frame: FakeDeepLocatorFrame = new Map();
    registerDeepLocatorHopElements(frame, `${FRAME_SELECTOR} >> select`, [""]);
    const page = makeFakePage(frame);
    // biome-ignore lint/suspicious/noExplicitAny: deliberately non-conforming payload shape under test
    const { frameTarget } = makeFakeFrameTarget(async () => ({ nope: true }) as any);

    const result = await selectDeepLocatorCandidateOption(
      // biome-ignore lint/suspicious/noExplicitAny: fake Page surface for the delegate contract under test
      page as any,
      FRAME_SELECTOR,
      "select",
      0,
      "US",
      { frameTarget }
    );

    expect(result).toBe(true);
    expect(frame.get(`${FRAME_SELECTOR} >> select`)?.selectedWith).toEqual(["US"]);
    expect(loggerStub.warn).toHaveBeenCalledWith(expect.stringContaining("non-conforming payload"));
  });

  it("with no frameTarget supplied and no evaluate seam resolvable, behaves byte-identically to the pre-batched delegate path", async () => {
    const frame: FakeDeepLocatorFrame = new Map();
    registerDeepLocatorHopElements(frame, `${FRAME_SELECTOR} >> select`, [""]);
    const deepLocatorSpy = vi.fn(makeFakeDeepLocator(frame));
    const page = { deepLocator: deepLocatorSpy };

    const result = await selectDeepLocatorCandidateOption(
      // biome-ignore lint/suspicious/noExplicitAny: fake Page surface for the delegate contract under test
      page as any,
      FRAME_SELECTOR,
      "select",
      0,
      "US"
    );

    expect(result).toBe(true);
    expect(deepLocatorSpy).toHaveBeenCalledWith(`${FRAME_SELECTOR} >> select`);
    expect(frame.get(`${FRAME_SELECTOR} >> select`)?.selectedWith).toEqual(["US"]);
    expect(loggerStub.warn).not.toHaveBeenCalled();
  });
});

describe("legacy-fallback watchdog scales with candidate index (matches clickDeepLocatorCandidate)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("a wedged fill() at index 40 is not killed by the flat call-timeout budget, and rejects with WatchdogTimeoutError once the scaled budget elapses", async () => {
    const TARGET_INDEX = 40;
    const frame: FakeDeepLocatorFrame = new Map();
    const { release } = registerDeepLocatorHangingHop(frame, `${FRAME_SELECTOR} >> input`, {
      hangOn: "fill",
    });
    const page = makeFakePage(frame);

    const promise = fillDeepLocatorCandidate(
      // biome-ignore lint/suspicious/noExplicitAny: fake Page surface for the delegate contract under test
      page as any,
      FRAME_SELECTOR,
      "input",
      TARGET_INDEX,
      "Ada",
      { callTimeoutMs: 50 }
    );
    let settled = false;
    promise.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      }
    );

    // The flat single-round-trip budget (50ms) elapses with no rejection —
    // a fixed callTimeoutMs would have killed this fill were it not scaled.
    await vi.advanceTimersByTimeAsync(50);
    expect(settled).toBe(false);

    // Scaled budget is 50 + 40 * DEEP_LOCATOR_CLICK_INDEX_ROUND_TRIP_MS
    // (1_000ms/index) = 40_050ms — a genuinely wedged fill still rejects
    // once that elapses, rather than hanging forever.
    const assertion = expect(promise).rejects.toMatchObject({ name: "WatchdogTimeoutError" });
    await vi.advanceTimersByTimeAsync(40_000);
    await assertion;
    release();
  });
});

describe("watchdog-guarded awaits (wedged fill/select/read-back)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("a wedged fill() rejects fillDeepLocatorCandidate within the call-timeout budget instead of hanging", async () => {
    const frame: FakeDeepLocatorFrame = new Map();
    const { release } = registerDeepLocatorHangingHop(frame, `${FRAME_SELECTOR} >> input`, {
      hangOn: "fill",
    });
    const page = makeFakePage(frame);

    const promise = fillDeepLocatorCandidate(
      // biome-ignore lint/suspicious/noExplicitAny: fake Page surface for the delegate contract under test
      page as any,
      FRAME_SELECTOR,
      "input",
      0,
      "Ada",
      { callTimeoutMs: 50 }
    );
    const assertion = expect(promise).rejects.toMatchObject({ name: "WatchdogTimeoutError" });

    await vi.advanceTimersByTimeAsync(50);
    await assertion;
    release();
  });

  it("a wedged inputValue() read-back rejects fillDeepLocatorCandidate within the call-timeout budget instead of hanging", async () => {
    const frame: FakeDeepLocatorFrame = new Map();
    const { release } = registerDeepLocatorHangingHop(frame, `${FRAME_SELECTOR} >> input`, {
      hangOn: "inputValue",
    });
    const page = makeFakePage(frame);

    const promise = fillDeepLocatorCandidate(
      // biome-ignore lint/suspicious/noExplicitAny: fake Page surface for the delegate contract under test
      page as any,
      FRAME_SELECTOR,
      "input",
      0,
      "Ada",
      { callTimeoutMs: 50 }
    );
    const assertion = expect(promise).rejects.toMatchObject({ name: "WatchdogTimeoutError" });

    await vi.advanceTimersByTimeAsync(50);
    await assertion;
    release();
  });

  it("a wedged selectOption() rejects selectDeepLocatorCandidateOption within the call-timeout budget instead of hanging", async () => {
    const frame: FakeDeepLocatorFrame = new Map();
    const { release } = registerDeepLocatorHangingHop(frame, `${FRAME_SELECTOR} >> select`, {
      hangOn: "selectOption",
    });
    const page = makeFakePage(frame);

    const promise = selectDeepLocatorCandidateOption(
      // biome-ignore lint/suspicious/noExplicitAny: fake Page surface for the delegate contract under test
      page as any,
      FRAME_SELECTOR,
      "select",
      0,
      "US",
      { callTimeoutMs: 50 }
    );
    const assertion = expect(promise).rejects.toMatchObject({ name: "WatchdogTimeoutError" });

    await vi.advanceTimersByTimeAsync(50);
    await assertion;
    release();
  });

  it("a wedged fill() rejects fillDeepLocatorCandidate at the 10s default when timeoutOptions is omitted", async () => {
    const frame: FakeDeepLocatorFrame = new Map();
    const { release } = registerDeepLocatorHangingHop(frame, `${FRAME_SELECTOR} >> input`, {
      hangOn: "fill",
    });
    const page = makeFakePage(frame);

    const promise = fillDeepLocatorCandidate(
      // biome-ignore lint/suspicious/noExplicitAny: fake Page surface for the delegate contract under test
      page as any,
      FRAME_SELECTOR,
      "input",
      0,
      "Ada"
    );
    const assertion = expect(promise).rejects.toMatchObject({ name: "WatchdogTimeoutError" });

    await vi.advanceTimersByTimeAsync(10_000);
    await assertion;
    release();
  });
});

describe("fillDeepLocatorCandidate/selectDeepLocatorCandidateOption batched actuation", () => {
  const TARGET_INDEX = 40;
  const INNER_SELECTOR = "input";
  const HOP_SELECTOR = `${FRAME_SELECTOR} >> ${INNER_SELECTOR}`;

  beforeEach(() => {
    loggerStub.warn.mockClear();
  });

  function buildHopWithTarget() {
    const frame: FakeDeepLocatorFrame = new Map();
    const hop = registerDeepLocatorHopElements(
      frame,
      HOP_SELECTOR,
      Array.from({ length: TARGET_INDEX + 1 }, () => "")
    );
    const deepLocatorSpy = vi.fn(makeFakeDeepLocator(frame));
    const page = { deepLocator: deepLocatorSpy };
    return { hop, page, deepLocatorSpy };
  }

  it("filling a candidate at index 40 costs exactly two frame evaluates (write + stuck-confirm) and zero delegate nth() resolves, given a frameTarget", async () => {
    const { page, deepLocatorSpy } = buildHopWithTarget();
    const { frameTarget, evaluateSpy } = makeFakeFrameTarget(async (expression: unknown) =>
      typeof expression === "string" &&
      expression.includes("querySelectorAll") &&
      !expression.includes("dispatchEvent")
        ? { value: "Ada" }
        : { written: true, readBack: "Ada" }
    );

    const result = await fillDeepLocatorCandidate(
      // biome-ignore lint/suspicious/noExplicitAny: fake Page surface for the delegate contract under test
      page as any,
      FRAME_SELECTOR,
      INNER_SELECTOR,
      TARGET_INDEX,
      "Ada",
      { frameTarget }
    );

    expect(result).toBe(true);
    expect(evaluateSpy).toHaveBeenCalledTimes(2);
    expect(deepLocatorSpy).not.toHaveBeenCalled();
  });

  it("falls back to the delegate write, rather than returning false outright, when the batched read-back disagrees with the written value", async () => {
    const { hop, page, deepLocatorSpy } = buildHopWithTarget();
    const { frameTarget } = makeFakeFrameTarget(async () => ({
      written: true,
      readBack: "wiped-by-react",
    }));

    const result = await fillDeepLocatorCandidate(
      // biome-ignore lint/suspicious/noExplicitAny: fake Page surface for the delegate contract under test
      page as any,
      FRAME_SELECTOR,
      INNER_SELECTOR,
      TARGET_INDEX,
      "Ada",
      { frameTarget }
    );

    expect(result).toBe(true);
    expect(deepLocatorSpy).toHaveBeenCalledWith(HOP_SELECTOR);
    expect(hop.elements[TARGET_INDEX]?.filledWith).toBe("Ada");
  });

  it("resolves false immediately, without falling back to the delegate, when the batched write reports an unrendered node", async () => {
    const { hop, page, deepLocatorSpy } = buildHopWithTarget();
    const { frameTarget } = makeFakeFrameTarget(async () => ({
      written: false,
      reason: "not-actionable",
    }));

    const result = await fillDeepLocatorCandidate(
      // biome-ignore lint/suspicious/noExplicitAny: fake Page surface for the delegate contract under test
      page as any,
      FRAME_SELECTOR,
      INNER_SELECTOR,
      TARGET_INDEX,
      "Ada",
      { frameTarget }
    );

    expect(result).toBe(false);
    expect(deepLocatorSpy).not.toHaveBeenCalled();
    expect(hop.elements[TARGET_INDEX]?.filledWith).toBeNull();
  });

  it("degrades to the delegate write when the batched evaluate call rejects, logging a warn", async () => {
    const { hop, page } = buildHopWithTarget();
    const { frameTarget } = makeFakeFrameTarget(async () => {
      throw new Error("evaluate wedged");
    });

    const result = await fillDeepLocatorCandidate(
      // biome-ignore lint/suspicious/noExplicitAny: fake Page surface for the delegate contract under test
      page as any,
      FRAME_SELECTOR,
      INNER_SELECTOR,
      TARGET_INDEX,
      "Ada",
      { frameTarget }
    );

    expect(result).toBe(true);
    expect(hop.elements[TARGET_INDEX]?.filledWith).toBe("Ada");
    expect(loggerStub.warn).toHaveBeenCalledWith(
      expect.stringContaining("deepLocator batched fill for")
    );
  });

  it("degrades to the delegate write when the batched evaluate resolves a non-conforming payload, logging a warn", async () => {
    const { hop, page } = buildHopWithTarget();
    const { frameTarget } = makeFakeFrameTarget(async () => ({ ok: true }));

    const result = await fillDeepLocatorCandidate(
      // biome-ignore lint/suspicious/noExplicitAny: fake Page surface for the delegate contract under test
      page as any,
      FRAME_SELECTOR,
      INNER_SELECTOR,
      TARGET_INDEX,
      "Ada",
      { frameTarget }
    );

    expect(result).toBe(true);
    expect(hop.elements[TARGET_INDEX]?.filledWith).toBe("Ada");
    expect(loggerStub.warn).toHaveBeenCalledWith(expect.stringContaining("non-conforming payload"));
  });

  it("degrades to the delegate write when the batched write reports a stale/out-of-range index", async () => {
    const { hop, page } = buildHopWithTarget();
    const { frameTarget } = makeFakeFrameTarget(async () => ({
      written: false,
      reason: "out-of-range",
    }));

    const result = await fillDeepLocatorCandidate(
      // biome-ignore lint/suspicious/noExplicitAny: fake Page surface for the delegate contract under test
      page as any,
      FRAME_SELECTOR,
      INNER_SELECTOR,
      TARGET_INDEX,
      "Ada",
      { frameTarget }
    );

    expect(result).toBe(true);
    expect(hop.elements[TARGET_INDEX]?.filledWith).toBe("Ada");
  });

  it("selecting an option at index 40 costs exactly two frame evaluates (write + stuck-confirm) and zero delegate nth() resolves, given a frameTarget", async () => {
    const selectHopSelector = `${FRAME_SELECTOR} >> select`;
    const frame: FakeDeepLocatorFrame = new Map();
    registerDeepLocatorHopElements(
      frame,
      selectHopSelector,
      Array.from({ length: TARGET_INDEX + 1 }, () => "")
    );
    const deepLocatorSpy = vi.fn(makeFakeDeepLocator(frame));
    const page = { deepLocator: deepLocatorSpy };
    const { frameTarget, evaluateSpy } = makeFakeFrameTarget(async (expression: unknown) =>
      typeof expression === "string" &&
      expression.includes("querySelectorAll") &&
      !expression.includes("dispatchEvent")
        ? { value: "US" }
        : { written: true, readBack: "US" }
    );

    const result = await selectDeepLocatorCandidateOption(
      // biome-ignore lint/suspicious/noExplicitAny: fake Page surface for the delegate contract under test
      page as any,
      FRAME_SELECTOR,
      "select",
      TARGET_INDEX,
      "US",
      { frameTarget }
    );

    expect(result).toBe(true);
    expect(evaluateSpy).toHaveBeenCalledTimes(2);
    expect(deepLocatorSpy).not.toHaveBeenCalled();
  });
});

describe("fillDeepLocatorCandidate/selectDeepLocatorCandidateOption legacy-fallback watchdog scales with candidate index", () => {
  const TARGET_INDEX = 40;
  const INNER_SELECTOR = "input";
  const HOP_SELECTOR = `${FRAME_SELECTOR} >> ${INNER_SELECTOR}`;
  /** Mirrors `deep-locator-candidates.click-budget.test.ts`'s measured per-round-trip cost through a proxied OOPIF. */
  const PER_ROUND_TRIP_MS = 659;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("completes a fill at index 40 under the fake's index-scaled latency instead of rejecting with WatchdogTimeoutError", async () => {
    const frame: FakeDeepLocatorFrame = new Map();
    const hop = registerDeepLocatorHopElements(
      frame,
      HOP_SELECTOR,
      Array.from({ length: TARGET_INDEX + 1 }, () => "")
    );
    registerDeepLocatorHopLatency(hop, {
      delayOn: ["fill", "inputValue"],
      delayMs: PER_ROUND_TRIP_MS,
    });
    const page = makeFakePage(frame);

    const promise = fillDeepLocatorCandidate(
      // biome-ignore lint/suspicious/noExplicitAny: fake Page surface for the delegate contract under test
      page as any,
      FRAME_SELECTOR,
      INNER_SELECTOR,
      TARGET_INDEX,
      "Ada"
    );

    // fill() and inputValue() are each individually charged (index + 1)
    // sequential round-trips by the fake delegate.
    await vi.advanceTimersByTimeAsync(2 * (TARGET_INDEX + 1) * PER_ROUND_TRIP_MS + 1);

    await expect(promise).resolves.toBe(true);
    expect(hop.elements[TARGET_INDEX]?.filledWith).toBe("Ada");
  });

  it("still rejects with WatchdogTimeoutError for a genuinely wedged fill (never settles) at a high index, instead of waiting forever", async () => {
    const page = {
      deepLocator: () => ({
        nth: () => ({
          fill: () => new Promise<void>(() => {}),
        }),
      }),
    };

    const promise = fillDeepLocatorCandidate(
      // biome-ignore lint/suspicious/noExplicitAny: fake Page surface for the delegate contract under test
      page as any,
      FRAME_SELECTOR,
      INNER_SELECTOR,
      TARGET_INDEX,
      "Ada",
      { callTimeoutMs: 50 }
    );
    const assertion = expect(promise).rejects.toMatchObject({ name: "WatchdogTimeoutError" });

    // Scaled budget at index 40 with callTimeoutMs 50 is 50 + 40 * (the
    // module's per-index constant) — comfortably under a minute even at a
    // generous per-index cost, so this is a safe upper bound for "the
    // watchdog fired" without depending on the constant's exact value.
    await vi.advanceTimersByTimeAsync(60_000);
    await assertion;
  });
});
