import { beforeEach, describe, expect, it, vi } from "vitest";
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

import { resolveDeepLocatorCandidates } from "@/scraper/deep-locator-candidates";
import {
  type FakeDeepLocatorFrame,
  makeFakeDeepLocator,
  makeFakeFrameScan,
  registerDeepLocatorHopElements,
} from "@/scraper/deep-locator-fake";

const HOP_SELECTOR = "#talemetry_apply_iframe >> *";

/**
 * Hand-built `FrameTarget` whose `evaluate` is a bare stub rather than one
 * bound to a fixture registry — the empty-scan case needs `evaluate` to
 * resolve `[]` independent of whatever the delegate's hop is registered
 * with, which `makeFakeFrameScan` (always mirrors the registry) can't model.
 */
function makeStubFrameTarget(evaluate: (...args: never[]) => Promise<unknown>): FrameTarget {
  return {
    frame: {} as unknown as FrameTarget["frame"],
    frameSelector: "#talemetry_apply_iframe",
    declaredFrameSelector: "#talemetry_apply_iframe",
    evaluate: evaluate as unknown as FrameTarget["evaluate"],
    locator: () => {
      throw new Error("locator() is not used by resolveDeepLocatorCandidates");
    },
    url: async () => "",
    title: async () => "",
  };
}

describe("resolveDeepLocatorCandidates empty batched-scan fallback", () => {
  beforeEach(() => {
    loggerStub.warn.mockClear();
  });

  it("degrades to the legacy per-candidate loop when the batched scan resolves zero matches but the delegate still reports candidates", async () => {
    const frame: FakeDeepLocatorFrame = new Map();
    registerDeepLocatorHopElements(frame, HOP_SELECTOR, ["Alpha", "Beta", "Gamma"]);
    const page = { deepLocator: makeFakeDeepLocator(frame) };
    const evaluateSpy = vi.fn().mockResolvedValue([]);
    const frameTarget = makeStubFrameTarget(evaluateSpy);

    const candidates = await resolveDeepLocatorCandidates(
      // biome-ignore lint/suspicious/noExplicitAny: fake Page surface for the delegate contract under test
      page as any,
      "#talemetry_apply_iframe",
      "*",
      null,
      { frameTarget }
    );

    expect(candidates.map((c) => c.accessibleText)).toEqual(["Alpha", "Beta", "Gamma"]);
    expect(evaluateSpy).toHaveBeenCalledTimes(1);
    expect(loggerStub.warn).toHaveBeenCalledWith(expect.stringContaining("matched zero elements"));
  });

  it("stays empty, without degrading, when the scan finds matches that are all visible:false", async () => {
    const frame: FakeDeepLocatorFrame = new Map();
    registerDeepLocatorHopElements(frame, HOP_SELECTOR, [
      { text: "Hidden One", visible: false },
      { text: "Hidden Two", visible: false },
    ]);
    const countSpy = vi.fn();
    const page = { deepLocator: vi.fn().mockReturnValue({ count: countSpy, nth: vi.fn() }) };
    const frameTarget = makeStubFrameTarget(makeFakeFrameScan(frame, HOP_SELECTOR));

    const candidates = await resolveDeepLocatorCandidates(
      // biome-ignore lint/suspicious/noExplicitAny: fake Page surface for the delegate contract under test
      page as any,
      "#talemetry_apply_iframe",
      "*",
      null,
      { frameTarget }
    );

    expect(candidates).toEqual([]);
    expect(countSpy).not.toHaveBeenCalled();
    expect(loggerStub.warn).toHaveBeenCalledWith(
      expect.stringContaining("dropped 2 unrendered candidate")
    );
    expect(loggerStub.warn).not.toHaveBeenCalledWith(
      expect.stringContaining("matched zero elements")
    );
  });
});
