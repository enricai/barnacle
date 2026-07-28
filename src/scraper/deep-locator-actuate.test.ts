import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  fillDeepLocatorCandidate,
  selectDeepLocatorCandidateOption,
} from "@/scraper/deep-locator-actuate";
import {
  type FakeDeepLocatorFrame,
  makeFakeDeepLocator,
  registerDeepLocatorHangingHop,
  registerDeepLocatorHopElements,
} from "@/scraper/deep-locator-fake";

const FRAME_SELECTOR = "#talemetry_apply_iframe";

function makeFakePage(frame: FakeDeepLocatorFrame) {
  return { deepLocator: makeFakeDeepLocator(frame) };
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
    expect(frame.get(`${FRAME_SELECTOR} >> select`)?.filledWith).toBe("US");
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
