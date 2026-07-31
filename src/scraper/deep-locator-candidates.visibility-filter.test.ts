/**
 * Pins `resolveDeepLocatorCandidates`'s visibility filter in isolation, at
 * the resolver seam feeding every flow-runner call site (Issue #2's
 * upstream half — a click can only hit an unrendered node if the resolver
 * offered it as a candidate in the first place). The `-32000`
 * click-classification side of the fix is pinned separately by
 * `deep-locator-candidates.layout-error.test.ts`; this file only proves
 * layout-less candidates never reach the cascade, that filtering doesn't
 * renumber survivors out of step with `clickDeepLocatorCandidate`'s `nth()`,
 * and that an empty-text candidate is retained (not mistaken for hidden).
 */
import { describe, expect, it, vi } from "vitest";
import type { FrameTarget } from "@/scraper/frame-target";

vi.mock("@/lib/logging", () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    errorWithStack: vi.fn(),
  }),
}));

import {
  clickDeepLocatorCandidate,
  resolveDeepLocatorCandidates,
} from "@/scraper/deep-locator-candidates";
import {
  type FakeDeepLocatorFrame,
  makeFakeDeepLocator,
  makeFakeFrameScan,
  registerDeepLocatorHopElements,
} from "@/scraper/deep-locator-fake";

const HOP_SELECTOR = "#talemetry_apply_iframe >> *";

/** Builds a `FrameTarget` whose `evaluate` reads back `frame`'s registered hop, exercising the batched-scan fast path the visibility filter lives on. */
function makeFakeFrameTarget(frame: FakeDeepLocatorFrame, selector: string): FrameTarget {
  return {
    frame: {} as unknown as FrameTarget["frame"],
    frameSelector: selector,
    declaredFrameSelector: selector,
    evaluate: makeFakeFrameScan(frame, selector) as unknown as FrameTarget["evaluate"],
    locator: () => {
      throw new Error("locator() is not used by resolveDeepLocatorCandidates");
    },
    url: async () => "",
    title: async () => "",
  };
}

describe("resolveDeepLocatorCandidates visibility filter", () => {
  it("returns only the laid-out elements from a hop of mixed visible/layout-less elements", async () => {
    const frame: FakeDeepLocatorFrame = new Map();
    registerDeepLocatorHopElements(frame, HOP_SELECTOR, [
      { text: "Upload Resume", visible: true },
      { text: "Hidden Decoy", visible: false },
      { text: "Manual Application", visible: true },
    ]);
    const frameTarget = makeFakeFrameTarget(frame, HOP_SELECTOR);
    const page = { deepLocator: makeFakeDeepLocator(frame) };

    const candidates = await resolveDeepLocatorCandidates(
      // biome-ignore lint/suspicious/noExplicitAny: fake Page surface for the delegate contract under test
      page as any,
      "#talemetry_apply_iframe",
      "*",
      null,
      { frameTarget }
    );

    expect(candidates.map((c) => c.accessibleText)).toEqual([
      "Upload Resume",
      "Manual Application",
    ]);
    expect(candidates.map((c) => c.index)).toEqual([0, 2]);
  });

  it("returns [] without throwing when every element in the hop is layout-less", async () => {
    const frame: FakeDeepLocatorFrame = new Map();
    registerDeepLocatorHopElements(frame, HOP_SELECTOR, [
      { text: "Hidden A", visible: false },
      { text: "Hidden B", visible: false },
    ]);
    const frameTarget = makeFakeFrameTarget(frame, HOP_SELECTOR);
    const page = { deepLocator: makeFakeDeepLocator(frame) };

    const candidates = await resolveDeepLocatorCandidates(
      // biome-ignore lint/suspicious/noExplicitAny: fake Page surface for the delegate contract under test
      page as any,
      "#talemetry_apply_iframe",
      "*",
      null,
      { frameTarget }
    );

    expect(candidates).toEqual([]);
  });

  it("preserves each surviving candidate's index so clickDeepLocatorCandidate still clicks the exact same element the filter kept", async () => {
    const frame: FakeDeepLocatorFrame = new Map();
    const hop = registerDeepLocatorHopElements(frame, HOP_SELECTOR, [
      { text: "Hidden Decoy", visible: false },
      { text: "Also Hidden", visible: false },
      { text: "Manual Application", visible: true },
    ]);
    const frameTarget = makeFakeFrameTarget(frame, HOP_SELECTOR);
    const page = { deepLocator: makeFakeDeepLocator(frame) };
    const timeoutOptions = { frameTarget };

    const candidates = await resolveDeepLocatorCandidates(
      // biome-ignore lint/suspicious/noExplicitAny: fake Page surface for the delegate contract under test
      page as any,
      "#talemetry_apply_iframe",
      "*",
      null,
      timeoutOptions
    );

    expect(candidates).toHaveLength(1);
    // biome-ignore lint/style/noNonNullAssertion: exactly one candidate survived filtering
    expect(candidates[0]!.index).toBe(2);

    await clickDeepLocatorCandidate(
      // biome-ignore lint/suspicious/noExplicitAny: fake Page surface for the delegate contract under test
      page as any,
      "#talemetry_apply_iframe",
      "*",
      // biome-ignore lint/style/noNonNullAssertion: exactly one candidate survived filtering
      candidates[0]!.index,
      timeoutOptions
    );

    expect(hop.elements[2]?.clicks).toBe(1);
    expect(hop.elements[0]?.clicks).toBe(0);
    expect(hop.elements[1]?.clicks).toBe(0);
  });

  it("retains a visible candidate with empty accessible text, ranking it at score 0 rather than dropping it as if hidden", async () => {
    const frame: FakeDeepLocatorFrame = new Map();
    registerDeepLocatorHopElements(frame, HOP_SELECTOR, [
      { text: "", visible: true },
      { text: "Decoy", visible: true },
      { text: "Manual Application", visible: true },
    ]);
    const frameTarget = makeFakeFrameTarget(frame, HOP_SELECTOR);
    const page = { deepLocator: makeFakeDeepLocator(frame) };

    const candidates = await resolveDeepLocatorCandidates(
      // biome-ignore lint/suspicious/noExplicitAny: fake Page surface for the delegate contract under test
      page as any,
      "#talemetry_apply_iframe",
      "*",
      "Do NOT click 'Decoy'. Click the 'Manual Application' button.",
      { frameTarget }
    );

    expect(candidates.map((c) => ({ index: c.index, accessibleText: c.accessibleText }))).toEqual([
      { index: 2, accessibleText: "Manual Application" },
      { index: 0, accessibleText: "" },
      { index: 1, accessibleText: "Decoy" },
    ]);
  });
});
