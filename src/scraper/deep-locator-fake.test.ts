import type { Page } from "@browserbasehq/stagehand";
import type { DeepLocatorDelegate } from "@browserbasehq/stagehand/lib/v3/understudy/deepLocator.js";
import { describe, expect, it } from "vitest";
import {
  type FakeDeepLocatorDelegate,
  type FakeDeepLocatorFrame,
  type HangingDeepLocatorMethod,
  makeFakeDeepLocator,
  makeFakeFrameScan,
  NODE_NOT_ACTIONABLE_MESSAGE,
  registerDeepLocatorHangingHop,
  registerDeepLocatorHop,
  registerDeepLocatorHopElements,
  registerDeepLocatorHopLatency,
} from "@/scraper/deep-locator-fake";
import { isNodeNotActionableError } from "@/scraper/deep-locator-scan";

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
