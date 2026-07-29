import type { Page } from "@browserbasehq/stagehand";
import type { DeepLocatorDelegate } from "@browserbasehq/stagehand/lib/v3/understudy/deepLocator.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  type FakeDeepLocatorDelegate,
  type FakeDeepLocatorFrame,
  type HangingDeepLocatorMethod,
  makeFakeDeepLocator,
  makeFakeDomElement,
  makeFakeFrameClickByIndex,
  makeFakeFrameFillByIndex,
  makeFakeFrameResolutionPage,
  makeFakeFrameScan,
  makeFakeFrameSelectByIndex,
  makeSelectorAwareDomRoot,
  NODE_NOT_ACTIONABLE_MESSAGE,
  registerDeepLocatorHangingHop,
  registerDeepLocatorHop,
  registerDeepLocatorHopElements,
  registerDeepLocatorHopLatency,
} from "@/scraper/deep-locator-fake";
import { isNodeNotActionableError } from "@/scraper/deep-locator-scan";
import { resolveFrameTarget } from "@/scraper/frame-target";

const STILL_PENDING = Symbol("still-pending");

/** Races `promise` against a 20ms timer resolving to a sentinel, the same shape a watchdog/timeout guard races a real deepLocator call against. */
function raceAgainstTimer(promise: Promise<unknown>): Promise<unknown> {
  return Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => resolve(STILL_PENDING), 20)),
  ]);
}

describe("deep-locator-fake", () => {
  it("count() is 1 for a registered hop selector and 0 for an unregistered one", async () => {
    const frame: FakeDeepLocatorFrame = new Map();
    registerDeepLocatorHop(frame, "iframe#talemetry_apply_iframe >> button#manual-application");
    const deepLocator = makeFakeDeepLocator(frame);

    await expect(
      deepLocator("iframe#talemetry_apply_iframe >> button#manual-application").count()
    ).resolves.toBe(1);
    await expect(
      deepLocator("iframe#talemetry_apply_iframe >> button#missing").count()
    ).resolves.toBe(0);
  });

  it("click() mutates the fake child frame's recorded state", async () => {
    const frame: FakeDeepLocatorFrame = new Map();
    const hop = registerDeepLocatorHop(
      frame,
      "iframe#talemetry_apply_iframe >> button#manual-application"
    );
    const deepLocator = makeFakeDeepLocator(frame);

    expect(hop.clicks).toBe(0);
    await deepLocator("iframe#talemetry_apply_iframe >> button#manual-application").click();
    expect(hop.clicks).toBe(1);
  });

  it("fill() records the filled value against the registered hop", async () => {
    const frame: FakeDeepLocatorFrame = new Map();
    const hop = registerDeepLocatorHop(frame, "iframe#talemetry_apply_iframe >> input#first-name");
    const deepLocator = makeFakeDeepLocator(frame);

    await deepLocator("iframe#talemetry_apply_iframe >> input#first-name").fill("Ada");
    expect(hop.filledWith).toBe("Ada");
  });

  it("first()/nth() return a delegate of the same shape, still resolving against the registry", async () => {
    const frame: FakeDeepLocatorFrame = new Map();
    const hop = registerDeepLocatorHop(frame, "iframe#talemetry_apply_iframe >> li.result");
    const deepLocator = makeFakeDeepLocator(frame);

    const first = deepLocator("iframe#talemetry_apply_iframe >> li.result").first();
    const second = deepLocator("iframe#talemetry_apply_iframe >> li.result").nth(1);

    await expect(first.count()).resolves.toBe(1);
    await expect(second.count()).resolves.toBe(1);
    await first.click();
    expect(hop.clicks).toBe(1);
  });

  it("registerDeepLocatorHopElements models N indexed candidates: count() is N, and nth(i).textContent() resolves in registration order", async () => {
    const frame: FakeDeepLocatorFrame = new Map();
    registerDeepLocatorHopElements(frame, "iframe#talemetry_apply_iframe >> *", [
      "container",
      "Upload a Resume/CV",
      "Manual Application",
    ]);
    const deepLocator = makeFakeDeepLocator(frame);

    await expect(deepLocator("iframe#talemetry_apply_iframe >> *").count()).resolves.toBe(3);
    await expect(
      deepLocator("iframe#talemetry_apply_iframe >> *").nth(0).textContent()
    ).resolves.toBe("container");
    await expect(
      deepLocator("iframe#talemetry_apply_iframe >> *").nth(1).textContent()
    ).resolves.toBe("Upload a Resume/CV");
    await expect(
      deepLocator("iframe#talemetry_apply_iframe >> *").nth(2).textContent()
    ).resolves.toBe("Manual Application");
  });

  it("nth(i).click() records the click against element i specifically, not the hop as a whole", async () => {
    const frame: FakeDeepLocatorFrame = new Map();
    const hop = registerDeepLocatorHopElements(frame, "iframe#talemetry_apply_iframe >> *", [
      "container",
      "Upload a Resume/CV",
      "Manual Application",
    ]);
    const deepLocator = makeFakeDeepLocator(frame);

    await deepLocator("iframe#talemetry_apply_iframe >> *").nth(2).click();

    expect(hop.elements.map((element) => element.clicks)).toEqual([0, 0, 1]);
  });

  it("registerDeepLocatorHopElements accepts a per-element visible spec, defaulting bare strings to visible: true", () => {
    const frame: FakeDeepLocatorFrame = new Map();
    const hop = registerDeepLocatorHopElements(frame, "iframe#talemetry_apply_iframe >> *", [
      "container",
      { text: "Upload a Resume/CV", visible: false },
      { text: "Manual Application" },
    ]);

    expect(hop.elements.map((element) => element.visible)).toEqual([true, false, true]);
  });

  it("makeFakeFrameScan returns the hop's elements as {index, text, visible} in registration order, ignoring the expression it's called with", async () => {
    const frame: FakeDeepLocatorFrame = new Map();
    registerDeepLocatorHopElements(frame, "iframe#talemetry_apply_iframe >> *", [
      "container",
      { text: "Upload a Resume/CV", visible: false },
      { text: "Manual Application", visible: true },
    ]);
    const scan = makeFakeFrameScan(frame, "iframe#talemetry_apply_iframe >> *");

    await expect(scan("() => { throw new Error('never executed by the fake'); }")).resolves.toEqual(
      [
        { index: 0, text: "container", visible: true },
        { index: 1, text: "Upload a Resume/CV", visible: false },
        { index: 2, text: "Manual Application", visible: true },
      ]
    );
  });

  it("makeFakeFrameScan resolves an empty array for an unregistered selector, and nth(i).textContent() still works for legacy consumers alongside it", async () => {
    const frame: FakeDeepLocatorFrame = new Map();
    registerDeepLocatorHopElements(frame, "iframe#talemetry_apply_iframe >> *", [
      "container",
      "Manual Application",
    ]);
    const deepLocator = makeFakeDeepLocator(frame);
    const scan = makeFakeFrameScan(frame, "iframe#talemetry_apply_iframe >> *");

    await expect(makeFakeFrameScan(frame, "iframe#missing >> *")()).resolves.toEqual([]);
    await expect(scan()).resolves.toHaveLength(2);
    await expect(
      deepLocator("iframe#talemetry_apply_iframe >> *").nth(1).textContent()
    ).resolves.toBe("Manual Application");
  });

  it("nth(i).click() on an element registered not-visible rejects with the CDP -32000 layout-object message, classified as not-actionable by isNodeNotActionableError", async () => {
    const frame: FakeDeepLocatorFrame = new Map();
    const hop = registerDeepLocatorHopElements(frame, "iframe#a >> button", [
      { text: "Manual Application", visible: false },
    ]);
    const deepLocator = makeFakeDeepLocator(frame);

    const click = deepLocator("iframe#a >> button").nth(0).click();

    await expect(click).rejects.toThrow(NODE_NOT_ACTIONABLE_MESSAGE);
    await click.catch((error: unknown) => {
      expect(isNodeNotActionableError(error)).toBe(true);
    });
    expect(hop.elements[0]?.clicks).toBe(0);
  });

  it("registerDeepLocatorHopLatency delays only the method(s) it's registered against, leaving other methods and other hops immediate", async () => {
    const frame: FakeDeepLocatorFrame = new Map();
    const hop = registerDeepLocatorHop(frame, "iframe#a >> b", "Manual Application");
    const otherHop = registerDeepLocatorHop(frame, "iframe#a >> c", "Upload a Resume/CV");
    registerDeepLocatorHopLatency(hop, { delayOn: "textContent", delayMs: 50 });
    const deepLocator = makeFakeDeepLocator(frame);

    await expect(raceAgainstTimer(deepLocator("iframe#a >> b").nth(0).textContent())).resolves.toBe(
      STILL_PENDING
    );
    await expect(raceAgainstTimer(deepLocator("iframe#a >> b").count())).resolves.not.toBe(
      STILL_PENDING
    );
    await expect(
      raceAgainstTimer(deepLocator("iframe#a >> c").nth(0).textContent())
    ).resolves.not.toBe(STILL_PENDING);
    expect(otherHop.text).toBe("Upload a Resume/CV");
  });

  it("registerDeepLocatorHopLatency on 'scan' delays makeFakeFrameScan but not nth(i).textContent() on the same hop", async () => {
    const frame: FakeDeepLocatorFrame = new Map();
    const hop = registerDeepLocatorHopElements(frame, "iframe#a >> *", ["Manual Application"]);
    registerDeepLocatorHopLatency(hop, { delayOn: "scan", delayMs: 50 });
    const deepLocator = makeFakeDeepLocator(frame);
    const scan = makeFakeFrameScan(frame, "iframe#a >> *");

    await expect(raceAgainstTimer(scan())).resolves.toBe(STILL_PENDING);
    await expect(
      raceAgainstTimer(deepLocator("iframe#a >> *").nth(0).textContent())
    ).resolves.not.toBe(STILL_PENDING);
  });

  it("click() throws for an unregistered hop, matching a real deepLocator finding no element", async () => {
    const frame: FakeDeepLocatorFrame = new Map();
    const deepLocator = makeFakeDeepLocator(frame);

    await expect(
      deepLocator("iframe#talemetry_apply_iframe >> button#missing").click()
    ).rejects.toThrow();
  });

  it("count()/nth(i).textContent()/nth(i).click() all never settle for a hop hanging on every method", async () => {
    const frame: FakeDeepLocatorFrame = new Map();
    const { release } = registerDeepLocatorHangingHop(frame, "iframe#a >> b", {
      hangOn: ["count", "textContent", "click"],
    });
    const deepLocator = makeFakeDeepLocator(frame);

    await expect(raceAgainstTimer(deepLocator("iframe#a >> b").count())).resolves.toBe(
      STILL_PENDING
    );
    await expect(raceAgainstTimer(deepLocator("iframe#a >> b").nth(0).textContent())).resolves.toBe(
      STILL_PENDING
    );
    await expect(raceAgainstTimer(deepLocator("iframe#a >> b").nth(0).click())).resolves.toBe(
      STILL_PENDING
    );

    release();
  });

  it.each<HangingDeepLocatorMethod>(["count", "textContent", "click"])(
    "hangOn: %s hangs only that method, leaving the other two to resolve normally",
    async (hungMethod) => {
      const frame: FakeDeepLocatorFrame = new Map();
      const { hop, release } = registerDeepLocatorHangingHop(frame, "iframe#a >> b", {
        hangOn: hungMethod,
        text: "Manual Application",
      });
      const deepLocator = makeFakeDeepLocator(frame);
      const callMethod = (method: HangingDeepLocatorMethod): Promise<unknown> => {
        const delegate = deepLocator("iframe#a >> b").nth(0);
        if (method === "count") return delegate.count();
        if (method === "textContent") return delegate.textContent();
        return delegate.click();
      };

      await expect(raceAgainstTimer(callMethod(hungMethod))).resolves.toBe(STILL_PENDING);

      const restingMethods = (["count", "textContent", "click"] as const).filter(
        (method) => method !== hungMethod
      );
      for (const method of restingMethods) {
        await expect(raceAgainstTimer(callMethod(method))).resolves.not.toBe(STILL_PENDING);
      }

      expect(hop.clicks).toBe(hungMethod === "click" ? 0 : 1);
      release();
    }
  );

  it("release() settles the previously pending promise instead of leaving it hung forever", async () => {
    const frame: FakeDeepLocatorFrame = new Map();
    const { release } = registerDeepLocatorHangingHop(frame, "iframe#a >> b", {
      hangOn: "count",
    });
    const deepLocator = makeFakeDeepLocator(frame);

    const pendingCount = deepLocator("iframe#a >> b").count();
    await expect(raceAgainstTimer(pendingCount)).resolves.toBe(STILL_PENDING);

    release();

    await expect(raceAgainstTimer(pendingCount)).resolves.toBe(1);
  });

  it("fill() is unaffected by a hop hanging on count/textContent/click", async () => {
    const frame: FakeDeepLocatorFrame = new Map();
    const { hop, release } = registerDeepLocatorHangingHop(frame, "iframe#a >> input", {
      hangOn: ["count", "textContent", "click"],
    });
    const deepLocator = makeFakeDeepLocator(frame);

    await deepLocator("iframe#a >> input").fill("Ada");
    expect(hop.filledWith).toBe("Ada");
    release();
  });

  it("type check: FakeDeepLocatorDelegate's modeled methods are assignable to the real DeepLocatorDelegate surface", () => {
    const frame: FakeDeepLocatorFrame = new Map();
    const delegate: FakeDeepLocatorDelegate = makeFakeDeepLocator(frame)("iframe#a >> b");

    const assertClick: DeepLocatorDelegate["click"] = delegate.click;
    const assertCount: DeepLocatorDelegate["count"] = delegate.count;
    const assertFill: DeepLocatorDelegate["fill"] = delegate.fill;
    expect([assertClick, assertCount, assertFill]).toHaveLength(3);
  });

  it("type check: a fake Page carrying this deepLocator is assignable to Stagehand's Page.deepLocator field", () => {
    const frame: FakeDeepLocatorFrame = new Map();
    const page = { deepLocator: makeFakeDeepLocator(frame) } as unknown as Pick<
      Page,
      "deepLocator"
    >;

    expect(typeof page.deepLocator).toBe("function");
  });
});

describe("deep-locator-fake: nth(index) resolve cost model (Stagehand's O(index) serial round-trips)", () => {
  const DELAY_MS = 100;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([0, 1, 2, 4])(
    "nth(%i).click() settles only after (index + 1) delay units, not one flat delay unit",
    async (index) => {
      const frame: FakeDeepLocatorFrame = new Map();
      const hop = registerDeepLocatorHopElements(
        frame,
        "iframe#a >> *",
        Array.from({ length: index + 1 }, (_, i) => `node-${i}`)
      );
      registerDeepLocatorHopLatency(hop, { delayOn: "click", delayMs: DELAY_MS });
      const deepLocator = makeFakeDeepLocator(frame);

      let settled = false;
      deepLocator("iframe#a >> *")
        .nth(index)
        .click()
        .then(() => {
          settled = true;
        });

      await vi.advanceTimersByTimeAsync(index * DELAY_MS);
      expect(settled).toBe(false);

      await vi.advanceTimersByTimeAsync(DELAY_MS);
      expect(settled).toBe(true);
      expect(hop.elements[index]?.clicks).toBe(1);
    }
  );

  it.each([0, 1, 3])(
    "nth(%i).textContent() settles only after (index + 1) delay units, not one flat delay unit",
    async (index) => {
      const frame: FakeDeepLocatorFrame = new Map();
      const hop = registerDeepLocatorHopElements(
        frame,
        "iframe#a >> *",
        Array.from({ length: index + 1 }, (_, i) => `node-${i}`)
      );
      registerDeepLocatorHopLatency(hop, { delayOn: "textContent", delayMs: DELAY_MS });
      const deepLocator = makeFakeDeepLocator(frame);

      let resolved: string | undefined;
      deepLocator("iframe#a >> *")
        .nth(index)
        .textContent()
        .then((value) => {
          resolved = value;
        });

      await vi.advanceTimersByTimeAsync(index * DELAY_MS);
      expect(resolved).toBeUndefined();

      await vi.advanceTimersByTimeAsync(DELAY_MS);
      expect(resolved).toBe(`node-${index}`);
    }
  );

  it.each([0, 1, 2, 4])(
    "nth(%i).fill() settles only after (index + 1) delay units, not one flat delay unit",
    async (index) => {
      const frame: FakeDeepLocatorFrame = new Map();
      const hop = registerDeepLocatorHopElements(
        frame,
        "iframe#a >> *",
        Array.from({ length: index + 1 }, (_, i) => `node-${i}`)
      );
      registerDeepLocatorHopLatency(hop, { delayOn: "fill", delayMs: DELAY_MS });
      const deepLocator = makeFakeDeepLocator(frame);

      let settled = false;
      deepLocator("iframe#a >> *")
        .nth(index)
        .fill("Ada")
        .then(() => {
          settled = true;
        });

      await vi.advanceTimersByTimeAsync(index * DELAY_MS);
      expect(settled).toBe(false);

      await vi.advanceTimersByTimeAsync(DELAY_MS);
      expect(settled).toBe(true);
      expect(hop.elements[index]?.filledWith).toBe("Ada");
    }
  );

  it.each([0, 1, 2, 4])(
    "nth(%i).selectOption() settles only after (index + 1) delay units, not one flat delay unit",
    async (index) => {
      const frame: FakeDeepLocatorFrame = new Map();
      const hop = registerDeepLocatorHopElements(
        frame,
        "iframe#a >> *",
        Array.from({ length: index + 1 }, (_, i) => `node-${i}`)
      );
      registerDeepLocatorHopLatency(hop, { delayOn: "selectOption", delayMs: DELAY_MS });
      const deepLocator = makeFakeDeepLocator(frame);

      let settled = false;
      deepLocator("iframe#a >> *")
        .nth(index)
        .selectOption("CA")
        .then(() => {
          settled = true;
        });

      await vi.advanceTimersByTimeAsync(index * DELAY_MS);
      expect(settled).toBe(false);

      await vi.advanceTimersByTimeAsync(DELAY_MS);
      expect(settled).toBe(true);
      expect(hop.elements[index]?.selectedWith).toEqual(["CA"]);
    }
  );

  it.each([0, 1, 2, 4])(
    "nth(%i).inputValue() settles only after (index + 1) delay units, not one flat delay unit",
    async (index) => {
      const frame: FakeDeepLocatorFrame = new Map();
      const hop = registerDeepLocatorHopElements(
        frame,
        "iframe#a >> *",
        Array.from({ length: index + 1 }, (_, i) => `node-${i}`)
      );
      const element = hop.elements[index];
      if (!element) throw new Error("test setup: expected element at index");
      element.readBackValue = `value-${index}`;
      registerDeepLocatorHopLatency(hop, { delayOn: "inputValue", delayMs: DELAY_MS });
      const deepLocator = makeFakeDeepLocator(frame);

      let resolved: string | undefined;
      deepLocator("iframe#a >> *")
        .nth(index)
        .inputValue()
        .then((value) => {
          resolved = value;
        });

      await vi.advanceTimersByTimeAsync(index * DELAY_MS);
      expect(resolved).toBeUndefined();

      await vi.advanceTimersByTimeAsync(DELAY_MS);
      expect(resolved).toBe(`value-${index}`);
    }
  );

  it("count() stays a flat one delay unit regardless of which index a caller chains nth() onto", async () => {
    const frame: FakeDeepLocatorFrame = new Map();
    const hop = registerDeepLocatorHopElements(frame, "iframe#a >> *", ["a", "b", "c", "d", "e"]);
    registerDeepLocatorHopLatency(hop, { delayOn: "count", delayMs: DELAY_MS });
    const deepLocator = makeFakeDeepLocator(frame);

    let resolved: number | undefined;
    deepLocator("iframe#a >> *")
      .nth(4)
      .count()
      .then((value) => {
        resolved = value;
      });

    await vi.advanceTimersByTimeAsync(DELAY_MS);
    expect(resolved).toBe(5);
  });
});

describe("makeFakeFrameClickByIndex (batched click-by-index seam)", () => {
  it("increments the targeted element's clicks counter and resolves clicked: true, ignoring the expression argument", async () => {
    const frame: FakeDeepLocatorFrame = new Map();
    const hop = registerDeepLocatorHopElements(frame, "iframe#a >> *", ["a", "b", "c"]);
    const clickByIndex = makeFakeFrameClickByIndex(frame, "iframe#a >> *");

    await expect(
      clickByIndex(2, "() => { throw new Error('never executed by the fake'); }")
    ).resolves.toEqual({ clicked: true });
    expect(hop.elements.map((element) => element.clicks)).toEqual([0, 0, 1]);
  });

  it("resolves clicked: false with the CDP layout-object reason for a not-visible element, without throwing and without incrementing clicks", async () => {
    const frame: FakeDeepLocatorFrame = new Map();
    const hop = registerDeepLocatorHopElements(frame, "iframe#a >> *", [
      { text: "hidden", visible: false },
    ]);
    const clickByIndex = makeFakeFrameClickByIndex(frame, "iframe#a >> *");

    await expect(clickByIndex(0)).resolves.toEqual({
      clicked: false,
      reason: NODE_NOT_ACTIONABLE_MESSAGE,
    });
    expect(hop.elements[0]?.clicks).toBe(0);
  });

  it("resolves clicked: false for an out-of-range index or an unregistered hop instead of throwing", async () => {
    const frame: FakeDeepLocatorFrame = new Map();
    registerDeepLocatorHopElements(frame, "iframe#a >> *", ["only-one"]);
    const clickByIndex = makeFakeFrameClickByIndex(frame, "iframe#a >> *");
    const clickByIndexUnregistered = makeFakeFrameClickByIndex(frame, "iframe#missing >> *");

    await expect(clickByIndex(3)).resolves.toEqual({
      clicked: false,
      reason: expect.stringContaining("index 3"),
    });
    await expect(clickByIndexUnregistered(0)).resolves.toEqual({
      clicked: false,
      reason: expect.stringContaining("index 0"),
    });
  });

  it("costs exactly one delay unit under a registered 'clickByIndex' latency profile, regardless of index", async () => {
    vi.useFakeTimers();
    try {
      const frame: FakeDeepLocatorFrame = new Map();
      const hop = registerDeepLocatorHopElements(
        frame,
        "iframe#a >> *",
        Array.from({ length: 5 }, (_, i) => `node-${i}`)
      );
      registerDeepLocatorHopLatency(hop, { delayOn: "clickByIndex", delayMs: 100 });
      const clickByIndex = makeFakeFrameClickByIndex(frame, "iframe#a >> *");

      let settled = false;
      clickByIndex(4).then(() => {
        settled = true;
      });

      await vi.advanceTimersByTimeAsync(99);
      expect(settled).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      expect(settled).toBe(true);
      expect(hop.elements[4]?.clicks).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("registerDeepLocatorHopLatency on 'clickByIndex' delays the batched click but not nth(i).click() on the same hop", async () => {
    const frame: FakeDeepLocatorFrame = new Map();
    const hop = registerDeepLocatorHopElements(frame, "iframe#a >> *", ["Manual Application"]);
    registerDeepLocatorHopLatency(hop, { delayOn: "clickByIndex", delayMs: 50 });
    const deepLocator = makeFakeDeepLocator(frame);
    const clickByIndex = makeFakeFrameClickByIndex(frame, "iframe#a >> *");

    await deepLocator("iframe#a >> *").nth(0).click();
    expect(hop.elements[0]?.clicks).toBe(1);

    await expect(raceAgainstTimer(clickByIndex(0))).resolves.toBe(STILL_PENDING);
  });
});

describe("makeFakeDomElement: writable form-control surface", () => {
  it("models an <input> whose value is readable/writable and whose dispatched events are recorded", () => {
    const input = makeFakeDomElement("", {
      tagName: "input",
      attributes: { "aria-label": "First Name" },
      value: "",
    });

    expect(input.value).toBe("");

    input.value = "Ada";
    input.dispatchEvent({ type: "input" });
    input.dispatchEvent({ type: "change" });
    input.dispatchEvent({ type: "blur" });

    expect(input.value).toBe("Ada");
    expect(input.dispatchedEvents).toEqual(["input", "change", "blur"]);
  });

  it("seeds an initial value via MakeFakeDomElementOptions.value instead of always starting empty", () => {
    const input = makeFakeDomElement("", { tagName: "input", value: "prefilled" });

    expect(input.value).toBe("prefilled");
  });

  it("is selectable through makeSelectorAwareDomRoot alongside read-only elements, and its writes are visible through the root", () => {
    const input = makeFakeDomElement("", {
      tagName: "input",
      attributes: { "aria-label": "First Name" },
    });
    const button = makeFakeDomElement("Submit", { tagName: "button" });
    const root = makeSelectorAwareDomRoot([input, button]);

    const [matched] = root.querySelectorAll("input");
    expect(matched).toBe(input);

    matched?.dispatchEvent({ type: "focus" });
    if (matched) matched.value = "Ada";

    expect(input.value).toBe("Ada");
    expect(input.dispatchedEvents).toEqual(["focus"]);
  });
});

describe.each([
  {
    label: "makeFakeFrameFillByIndex",
    make: makeFakeFrameFillByIndex,
    latencyMethod: "fillByIndex" as const,
  },
  {
    label: "makeFakeFrameSelectByIndex",
    make: makeFakeFrameSelectByIndex,
    latencyMethod: "selectByIndex" as const,
  },
])("$label (batched write-by-index seam)", ({ make, latencyMethod }) => {
  it("writes the value into elements[index].filledWith and resolves {written: true, readBack}, ignoring the expression argument", async () => {
    const frame: FakeDeepLocatorFrame = new Map();
    const hop = registerDeepLocatorHopElements(frame, "iframe#a >> *", ["a", "b", "c"]);
    const writeByIndex = make(frame, "iframe#a >> *");

    await expect(
      writeByIndex(1, "First Name", "() => { throw new Error('never executed by the fake'); }")
    ).resolves.toEqual({ written: true, readBack: "First Name" });
    expect(hop.elements.map((element) => element.filledWith)).toEqual([null, "First Name", null]);
  });

  it("resolves {written: false, reason: 'not-actionable'} for a visible:false element, without throwing and without touching filledWith", async () => {
    const frame: FakeDeepLocatorFrame = new Map();
    const hop = registerDeepLocatorHopElements(frame, "iframe#a >> *", [
      { text: "hidden", visible: false },
    ]);
    const writeByIndex = make(frame, "iframe#a >> *");

    await expect(writeByIndex(0, "value")).resolves.toEqual({
      written: false,
      reason: "not-actionable",
    });
    expect(hop.elements[0]?.filledWith).toBeNull();
  });

  it("resolves {written: false, reason: 'out-of-range'} for an out-of-range index or an unregistered hop instead of throwing", async () => {
    const frame: FakeDeepLocatorFrame = new Map();
    registerDeepLocatorHopElements(frame, "iframe#a >> *", ["only-one"]);
    const writeByIndex = make(frame, "iframe#a >> *");
    const writeByIndexUnregistered = make(frame, "iframe#missing >> *");

    await expect(writeByIndex(3, "value")).resolves.toEqual({
      written: false,
      reason: "out-of-range",
    });
    await expect(writeByIndexUnregistered(0, "value")).resolves.toEqual({
      written: false,
      reason: "out-of-range",
    });
  });

  it("honors a readBackValue override the same way inputValue() does", async () => {
    const frame: FakeDeepLocatorFrame = new Map();
    const hop = registerDeepLocatorHopElements(frame, "iframe#a >> *", ["a"]);
    const element = hop.elements[0];
    if (!element) throw new Error("expected element at index 0");
    element.readBackValue = "normalized";
    const writeByIndex = make(frame, "iframe#a >> *");

    await expect(writeByIndex(0, "raw")).resolves.toEqual({
      written: true,
      readBack: "normalized",
    });
    expect(hop.elements[0]?.filledWith).toBe("raw");
  });

  it(`costs exactly one delay unit under a registered '${latencyMethod}' latency profile, regardless of index`, async () => {
    vi.useFakeTimers();
    try {
      const frame: FakeDeepLocatorFrame = new Map();
      const hop = registerDeepLocatorHopElements(
        frame,
        "iframe#a >> *",
        Array.from({ length: 5 }, (_, i) => `node-${i}`)
      );
      registerDeepLocatorHopLatency(hop, { delayOn: latencyMethod, delayMs: 100 });
      const writeByIndex = make(frame, "iframe#a >> *");

      let settled = false;
      writeByIndex(4, "value").then(() => {
        settled = true;
      });

      await vi.advanceTimersByTimeAsync(99);
      expect(settled).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      expect(settled).toBe(true);
      expect(hop.elements[4]?.filledWith).toBe("value");
    } finally {
      vi.useRealTimers();
    }
  });

  it(`registerDeepLocatorHopLatency on '${latencyMethod}' delays the batched write but not nth(i).fill()/selectOption() on the same hop`, async () => {
    const frame: FakeDeepLocatorFrame = new Map();
    const hop = registerDeepLocatorHopElements(frame, "iframe#a >> *", ["First Name"]);
    registerDeepLocatorHopLatency(hop, { delayOn: latencyMethod, delayMs: 50 });
    const deepLocator = makeFakeDeepLocator(frame);
    const writeByIndex = make(frame, "iframe#a >> *");

    await deepLocator("iframe#a >> *").nth(0).fill("legacy-path");
    expect(hop.elements[0]?.filledWith).toBe("legacy-path");

    await expect(raceAgainstTimer(writeByIndex(0, "batched-path"))).resolves.toBe(STILL_PENDING);
  });
});

/**
 * Pins {@link makeFakeFrameResolutionPage}'s core contract: the fake's
 * `probeDelayMs` dial genuinely decides whether it wins or loses a
 * `{ timeoutMs: 0 }` watchdog race, the same race every existing OOPIF
 * throughput fixture's hand-rolled same-tick fake always wins regardless of
 * production CDP latency (`deep-locator-candidates.internal-frame-
 * resolution.test.ts`'s docblock). Without this, a fixture that always wins
 * that race can't distinguish "the batched fast path is reachable" from
 * "the batched fast path is reachable ONLY because the fake never models
 * real latency" — exactly what masked the production degrade perf-001/
 * perf-003/perf-004 address.
 */
describe("makeFakeFrameResolutionPage", () => {
  const IFRAME_SELECTOR = "iframe#talemetry_apply_iframe";
  const CHILD_SRC = "https://apply.talemetry.com/application/abc-123";

  beforeEach(() => {
    loggerStub.warn.mockClear();
  });

  it("case (a): probeDelayMs 0 resolves through resolveFrameTarget's zero-budget pass — a same-tick fake wins the watchdog race", async () => {
    const { page, iframeProbeSpy, locationProbeSpy } = makeFakeFrameResolutionPage({
      iframeSelector: IFRAME_SELECTOR,
      childSrc: CHILD_SRC,
      probeDelayMs: 0,
    });

    const target = await resolveFrameTarget(page, IFRAME_SELECTOR, { timeoutMs: 0 });

    expect(target.frame).not.toBeNull();
    expect(target.frameSelector).toBe(IFRAME_SELECTOR);
    expect(iframeProbeSpy).toHaveBeenCalledTimes(1);
    expect(locationProbeSpy).toHaveBeenCalledTimes(1);
  });

  it("case (b): a positive probeDelayMs always loses resolveFrameTarget's zero-budget pass — reproducing the production degrade every same-tick throughput fixture masks", async () => {
    const { page } = makeFakeFrameResolutionPage({
      iframeSelector: IFRAME_SELECTOR,
      childSrc: CHILD_SRC,
      probeDelayMs: 5,
    });

    const target = await resolveFrameTarget(page, IFRAME_SELECTOR, { timeoutMs: 0 });

    expect(target.frame).toBeNull();
    expect(target.frameSelector).toBeNull();
  });

  /**
   * The seed for this subtask asked this case to resolve through perf-001's
   * `probeAttachedFrameTarget` (`frame-target.ts`) instead. `perf-001` is a
   * sibling subtask with no `depends_on`/`requires` edge to this one, and its
   * commit had not been merged into this branch at implementation time —
   * importing it here would make this file fail to compile/run in isolation.
   * This asserts the same underlying property (the fake genuinely settles
   * after `probeDelayMs`, rather than hanging, once given an adequate real
   * budget) via the existing polling `resolveFrameTarget` instead; see
   * `criteria/perf-002.md` for the full rationale. Once both subtasks land on
   * `main`, a follow-up can freely repoint this same assertion at
   * `probeAttachedFrameTarget` with zero changes needed to the fake.
   */
  it("case (b, cont.): the same latency-realistic pair still resolves once resolveFrameTarget is given a real, non-zero attach budget covering the delay", async () => {
    const { page } = makeFakeFrameResolutionPage({
      iframeSelector: IFRAME_SELECTOR,
      childSrc: CHILD_SRC,
      probeDelayMs: 5,
    });

    const target = await resolveFrameTarget(page, IFRAME_SELECTOR, {
      timeoutMs: 50,
      pollMs: 5,
      evaluateTimeoutMs: 50,
    });

    expect(target.frame).not.toBeNull();
    expect(target.frameSelector).toBe(IFRAME_SELECTOR);
  });

  it("routes an unmatched iframe selector to a non-matching probe result rather than throwing", async () => {
    const { page } = makeFakeFrameResolutionPage({
      iframeSelector: IFRAME_SELECTOR,
      childSrc: CHILD_SRC,
    });

    const target = await resolveFrameTarget(page, "iframe#does-not-exist", { timeoutMs: 0 });

    expect(target.frame).toBeNull();
  });

  it("falls through onFrameEvaluate for expressions other than the location.href probe", async () => {
    const onFrameEvaluate = vi.fn().mockResolvedValue("custom-result");
    const { childFrame } = makeFakeFrameResolutionPage({
      iframeSelector: IFRAME_SELECTOR,
      childSrc: CHILD_SRC,
      onFrameEvaluate,
    });

    const result = await childFrame.evaluate("some-other-expression");

    expect(result).toBe("custom-result");
    expect(onFrameEvaluate).toHaveBeenCalledWith("some-other-expression");
  });
});
