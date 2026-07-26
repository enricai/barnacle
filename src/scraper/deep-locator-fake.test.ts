import type { Page } from "@browserbasehq/stagehand";
import type { DeepLocatorDelegate } from "@browserbasehq/stagehand/lib/v3/understudy/deepLocator.js";
import { describe, expect, it } from "vitest";
import {
  type FakeDeepLocatorDelegate,
  type FakeDeepLocatorFrame,
  makeFakeDeepLocator,
  registerDeepLocatorHop,
} from "@/scraper/deep-locator-fake";

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

  it("click() throws for an unregistered hop, matching a real deepLocator finding no element", async () => {
    const frame: FakeDeepLocatorFrame = new Map();
    const deepLocator = makeFakeDeepLocator(frame);

    await expect(
      deepLocator("iframe#talemetry_apply_iframe >> button#missing").click()
    ).rejects.toThrow();
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
