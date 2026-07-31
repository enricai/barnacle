import { describe, expect, it, vi } from "vitest";
import {
  clickDeepLocatorCandidate,
  resolveDeepLocatorCandidates,
} from "@/scraper/deep-locator-candidates";
import {
  type FakeDeepLocatorFrame,
  makeFakeDeepLocator,
  registerDeepLocatorHopElements,
} from "@/scraper/deep-locator-fake";

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
  rejectTextContentAt?: number[];
}) {
  const texts = options.texts ?? [];
  const clickSpy = options.clickSpy ?? vi.fn().mockResolvedValue(undefined);
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

describe("resolveDeepLocatorCandidates", () => {
  it("returns a candidate per matched element in delegate order, each deeplocator=-prefixed (not xpath=) and hop-composed, when no instruction is given", async () => {
    const delegate = makeFakeDelegate({ count: 2, texts: ["Manual Application", "Cancel"] });
    const { page, deepLocatorSpy } = makeFakePage(delegate);

    const candidates = await resolveDeepLocatorCandidates(
      // biome-ignore lint/suspicious/noExplicitAny: fake Page surface for the delegate contract under test
      page as any,
      "#talemetry_apply_iframe",
      "button"
    );

    expect(candidates).toEqual([
      {
        index: 0,
        selector: "deeplocator=#talemetry_apply_iframe >> button >> nth=0",
        accessibleText: "Manual Application",
      },
      {
        index: 1,
        selector: "deeplocator=#talemetry_apply_iframe >> button >> nth=1",
        accessibleText: "Cancel",
      },
    ]);
    expect(deepLocatorSpy).toHaveBeenCalledWith("#talemetry_apply_iframe >> button");
  });

  it("never emits an xpath=-prefixed selector, since hop notation is not evaluable via document.evaluate on the top-level document", async () => {
    const delegate = makeFakeDelegate({ count: 1, texts: ["Manual Application"] });
    const { page } = makeFakePage(delegate);

    const candidates = await resolveDeepLocatorCandidates(
      // biome-ignore lint/suspicious/noExplicitAny: fake Page surface for the delegate contract under test
      page as any,
      "#talemetry_apply_iframe",
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
      "#talemetry_apply_iframe",
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
      "#talemetry_apply_iframe",
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
      "#talemetry_apply_iframe",
      "*"
    );

    expect(candidates).toEqual([
      {
        index: 0,
        selector: "deeplocator=#talemetry_apply_iframe >> * >> nth=0",
        accessibleText: "",
      },
      {
        index: 1,
        selector: "deeplocator=#talemetry_apply_iframe >> * >> nth=1",
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
      "#talemetry_apply_iframe",
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
      registerDeepLocatorHopElements(frame, "#talemetry_apply_iframe >> *", [
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
        "#talemetry_apply_iframe",
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
        "#talemetry_apply_iframe",
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
        "#talemetry_apply_iframe",
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
        "#talemetry_apply_iframe",
        "*",
        "click the manual application button"
      );

      expect(candidates.map((c) => c.accessibleText)).toEqual(["Manual Application", "Cancel"]);
    });
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
      "#talemetry_apply_iframe",
      "button",
      0
    );

    expect(deepLocatorSpy).toHaveBeenCalledWith("#talemetry_apply_iframe >> button");
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
      clickDeepLocatorCandidate(page as any, "#talemetry_apply_iframe", "button", 0)
    ).rejects.toThrow("element not attached");
  });
});
