import { describe, expect, it, vi } from "vitest";
import {
  clickDeepLocatorCandidate,
  resolveDeepLocatorCandidates,
} from "@/scraper/deep-locator-candidates";

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
}) {
  const texts = options.texts ?? [];
  const clickSpy = options.clickSpy ?? vi.fn().mockResolvedValue(undefined);
  const countFn =
    typeof options.count === "function" ? options.count : async () => options.count as number;
  return {
    count: countFn,
    nth: (index: number) => ({
      textContent: async () => texts[index] ?? "",
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
  it("returns a ranked candidate per matched element, each xpath=-prefixed and hop-composed", async () => {
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
        selector: "xpath=#talemetry_apply_iframe >> button >> nth=0",
        accessibleText: "Manual Application",
      },
      {
        index: 1,
        selector: "xpath=#talemetry_apply_iframe >> button >> nth=1",
        accessibleText: "Cancel",
      },
    ]);
    expect(deepLocatorSpy).toHaveBeenCalledWith("#talemetry_apply_iframe >> button");
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

  it("composes an unscoped selector unchanged when frameSelector is null (buildHopSelector passthrough)", async () => {
    const delegate = makeFakeDelegate({ count: 1, texts: ["Submit"] });
    const { page, deepLocatorSpy } = makeFakePage(delegate);

    // biome-ignore lint/suspicious/noExplicitAny: fake Page surface for the delegate contract under test
    await resolveDeepLocatorCandidates(page as any, null, "button[type=submit]");

    expect(deepLocatorSpy).toHaveBeenCalledWith("button[type=submit]");
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
