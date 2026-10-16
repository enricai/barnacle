import { describe, expect, it, vi } from "vitest";
import type { FrameTarget } from "@/scraper/frame-target";
import {
  buildCentreAndHitTestFn,
  CENTRE_AND_HIT_TEST_FN,
  CentredClickError,
  type CentredHitTestResult,
  centreSelectorForClick,
  clickAfterCentredHitTest,
  clickCentredTrusted,
  firstMatchClickable,
} from "@/scraper/trusted-click";

function fakeTarget(results: CentredHitTestResult[], order: string[]): FrameTarget {
  const queue = [...results];
  const last = results[results.length - 1];
  return {
    frame: null,
    frameSelector: null,
    evaluate: vi.fn(async () => {
      order.push("evaluate");
      return queue.shift() ?? last;
    }) as unknown as FrameTarget["evaluate"],
    locator: vi.fn(() => ({
      click: async (): Promise<void> => {
        order.push("click");
      },
    })) as unknown as FrameTarget["locator"],
    url: async () => "https://example.com",
    title: async () => "",
  };
}

describe("clickCentredTrusted", () => {
  it("centres via scrollIntoView before a single click when not occluded", async () => {
    const order: string[] = [];
    const target = fakeTarget([{ state: "hit" }], order);
    await clickCentredTrusted(target, "#save");
    expect(order).toEqual(["evaluate", "click"]);
    const expr = vi.mocked(target.evaluate).mock.calls[0]?.[0] as string;
    expect(expr).toContain('block: "center"');
    expect(expr).toContain("querySelector");
  });

  it("uses document.evaluate for xpath= selectors", async () => {
    const order: string[] = [];
    const target = fakeTarget([{ state: "hit" }], order);
    await clickCentredTrusted(target, "xpath=//button[1]");
    expect(vi.mocked(target.evaluate).mock.calls[0]?.[0]).toContain("document.evaluate");
  });

  it("re-centres and retries when a fixed footer covers the point", async () => {
    const order: string[] = [];
    const target = fakeTarget(
      [{ state: "occluded", occluder: "footer#bar" }, { state: "hit" }],
      order
    );
    await clickCentredTrusted(target, "#save");
    expect(order).toEqual(["evaluate", "evaluate", "click"]);
  });

  it("throws without clicking when still occluded", async () => {
    const order: string[] = [];
    const target = fakeTarget([{ state: "occluded", occluder: "footer#bar" }], order);
    await expect(clickCentredTrusted(target, "#save", { attempts: 2 })).rejects.toThrow(
      /occluded by footer#bar after 2 attempts/
    );
    expect(order).not.toContain("click");
  });
});

describe("clickAfterCentredHitTest", () => {
  it("passes the centring function to the injected element evaluator (deep-locator form)", async () => {
    const click = vi.fn(async () => {});
    const evaluateOnElement = vi.fn(async () => ({ state: "hit" }) as CentredHitTestResult);
    await clickAfterCentredHitTest({ click }, evaluateOnElement);
    expect(evaluateOnElement).toHaveBeenCalledWith(CENTRE_AND_HIT_TEST_FN);
    expect(click).toHaveBeenCalledTimes(1);
  });

  it("throws on a missing element without clicking", async () => {
    const click = vi.fn(async () => {});
    await expect(
      clickAfterCentredHitTest({ click }, async () => ({ state: "missing" }), { attempts: 1 })
    ).rejects.toThrow(/not in the document/);
    expect(click).not.toHaveBeenCalled();
  });
});

describe("centreSelectorForClick", () => {
  it("re-centres past a sticky overlay and resolves without clicking", async () => {
    const order: string[] = [];
    const target = fakeTarget(
      [{ state: "occluded", occluder: "header#sticky" }, { state: "hit" }],
      order
    );
    await centreSelectorForClick(target, "#save");
    expect(order).toEqual(["evaluate", "evaluate"]);
  });

  it("throws without clicking when still occluded", async () => {
    const order: string[] = [];
    const target = fakeTarget([{ state: "occluded", occluder: "header#sticky" }], order);
    await expect(centreSelectorForClick(target, "#save", { attempts: 2 })).rejects.toThrow(
      /occluded by header#sticky after 2 attempts/
    );
    expect(order).toEqual(["evaluate", "evaluate"]);
  });
});

describe("firstMatchClickable", () => {
  it("clicks a self-clicking locator directly", () => {
    const locator = { click: vi.fn(), first: vi.fn() };
    expect(firstMatchClickable(locator as never)).toBe(locator);
    expect(locator.first).not.toHaveBeenCalled();
  });

  it("narrows a first()-only locator to its first match", () => {
    const first = { click: vi.fn() };
    expect(firstMatchClickable({ first: () => first } as never)).toBe(first);
  });
});

describe("verifyBeforeClick", () => {
  it("withholds the click as an identity mismatch when the pre-click check fails", async () => {
    const click = vi.fn(async () => {});
    await expect(
      clickAfterCentredHitTest({ click }, async () => ({ state: "hit" }), {
        verifyBeforeClick: async () => false,
      })
    ).rejects.toThrow(/identity mismatch/);
    expect(click).not.toHaveBeenCalled();
  });

  it("clicks once the pre-click check passes", async () => {
    const click = vi.fn(async () => {});
    await clickAfterCentredHitTest({ click }, async () => ({ state: "hit" }), {
      verifyBeforeClick: async () => true,
    });
    expect(click).toHaveBeenCalledTimes(1);
  });
});

describe("identity expectation", () => {
  it("withholds the click and reports a mismatch", async () => {
    const click = vi.fn(async () => {});
    const evaluateOnElement = vi.fn(
      async (_fn: string) => ({ state: "mismatch" }) as CentredHitTestResult
    );
    await expect(
      clickAfterCentredHitTest({ click }, evaluateOnElement, { expectText: "Row 7" })
    ).rejects.toThrow(/identity mismatch/);
    expect(click).not.toHaveBeenCalled();
    expect(evaluateOnElement).toHaveBeenCalledTimes(1);
    expect(vi.mocked(evaluateOnElement).mock.calls[0]?.[0]).toContain('"Row 7"');
  });

  it("clicks once when the identity check passes", async () => {
    const click = vi.fn(async () => {});
    await clickAfterCentredHitTest({ click }, async () => ({ state: "hit" }), {
      expectText: "Row 7",
    });
    expect(click).toHaveBeenCalledTimes(1);
  });

  it("scrolls instantly so a smooth-scrolling page is hit-tested settled, not under a sticky cookie bar on example.com", () => {
    const expected = 'scrollIntoView({ block: "center", inline: "center", behavior: "instant" })';
    expect(CENTRE_AND_HIT_TEST_FN).toContain(expected);
    expect(buildCentreAndHitTestFn("Row 7")).toContain(expected);
  });

  it("runs the in-page check after scroll and before hit-test", () => {
    const fn = buildCentreAndHitTestFn("Row 7");
    expect(fn.indexOf("scrollIntoView")).toBeLessThan(fn.indexOf("mismatch"));
    expect(fn.indexOf("mismatch")).toBeLessThan(fn.indexOf("elementFromPoint"));
    expect(buildCentreAndHitTestFn()).toBe(CENTRE_AND_HIT_TEST_FN);
  });
});

describe("clickCentredTrusted expectText", () => {
  it("embeds the identity check in the selector expression and withholds on mismatch", async () => {
    const order: string[] = [];
    const target = fakeTarget([{ state: "mismatch" }], order);
    await expect(clickCentredTrusted(target, "#row", { expectText: "Row 7" })).rejects.toThrow(
      /identity mismatch/
    );
    expect(order).toEqual(["evaluate"]);
    const expr = vi.mocked(target.evaluate).mock.calls[0]?.[0] as string;
    expect(expr).toContain('"Row 7"');
    expect(expr).toContain("\\s+");
  });

  it("executes the generated function and compares normalised text", () => {
    const make = (text: string): object => ({
      isConnected: true,
      textContent: text,
      scrollIntoView: () => {},
    });
    const run = (expected: string, text: string): { state: string } =>
      new Function(`return (${buildCentreAndHitTestFn(expected)})`)().call(make(text));
    expect(run("Row 7", "Row 8").state).toBe("mismatch");
    expect(() => run("Row 7", "  Row\n   7 ")).toThrow(/getBoundingClientRect/);
  });
});

describe("centre probe executed against a fake element", () => {
  interface ScrollCall {
    block: string;
    behavior: string;
  }

  function fakeElement(opts: { footerCoversAfterScroll: boolean }): {
    el: object;
    scrolls: ScrollCall[];
  } {
    const scrolls: ScrollCall[] = [];
    const footer = { tagName: "FOOTER", id: "bar", parentNode: null };
    const el: Record<string, unknown> = {
      isConnected: true,
      tagName: "BUTTON",
      parentNode: null,
      scrollIntoView: (o: ScrollCall): void => {
        scrolls.push(o);
      },
      getBoundingClientRect: () => ({ left: 0, right: 100, top: 0, bottom: 40 }),
    };
    el.getRootNode = () => ({
      elementFromPoint: () => {
        const settled = scrolls.some((s) => s.behavior === "instant");
        return settled && !opts.footerCoversAfterScroll ? el : footer;
      },
    });
    return { el, scrolls };
  }

  function runProbe(el: object): CentredHitTestResult {
    vi.stubGlobal("getComputedStyle", () => ({}));
    try {
      return new Function(`return (${CENTRE_AND_HIT_TEST_FN})`)().call(el);
    } finally {
      vi.unstubAllGlobals();
    }
  }

  it("reports hit when the instant scroll moves the control clear of a sticky bottom:0 footer", () => {
    const { el, scrolls } = fakeElement({ footerCoversAfterScroll: false });
    expect(runProbe(el)).toEqual({ state: "hit" });
    expect(scrolls).toEqual([{ block: "center", inline: "center", behavior: "instant" }]);
  });

  it("re-centres on each retry pass so no pass reads a pre-scroll position", async () => {
    const { el, scrolls } = fakeElement({ footerCoversAfterScroll: false });
    const results: CentredHitTestResult[] = [{ state: "occluded", occluder: "footer#bar" }];
    const evaluateOnElement = vi.fn(async (fn: string) => {
      const r = results.shift();
      if (r) return r;
      expect(fn).toBe(CENTRE_AND_HIT_TEST_FN);
      return runProbe(el);
    });
    const click = vi.fn(async () => {});
    await clickAfterCentredHitTest({ click }, evaluateOnElement);
    expect(evaluateOnElement).toHaveBeenCalledTimes(2);
    expect(scrolls).toHaveLength(1);
    expect(click).toHaveBeenCalledTimes(1);
  });

  it("throws CentredClickError without clicking when still occluded after every attempt", async () => {
    const { el, scrolls } = fakeElement({ footerCoversAfterScroll: true });
    const click = vi.fn(async () => {});
    const err = await clickAfterCentredHitTest({ click }, async () => runProbe(el), {
      attempts: 3,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CentredClickError);
    expect((err as CentredClickError).state).toBe("occluded");
    expect((err as Error).message).toMatch(/occluded by footer#bar after 3 attempts/);
    expect(scrolls).toHaveLength(3);
    expect(click).not.toHaveBeenCalled();
  });
});
