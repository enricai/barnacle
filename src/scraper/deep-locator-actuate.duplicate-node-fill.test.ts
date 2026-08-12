import { describe, expect, it } from "vitest";
import { fillDeepLocatorCandidate } from "@/scraper/deep-locator-actuate";
import { resolveDeepLocatorCandidates } from "@/scraper/deep-locator-candidates";
import {
  type FakeDeepLocatorFrame,
  makeFakeDeepLocator,
  registerDeepLocatorHopElements,
} from "@/scraper/deep-locator-fake";

const FRAME_SELECTOR = "#apply_frame";

/**
 * Regression pin for the bug report's flagged (unconfirmed) duplicate-node
 * lead: two DOM nodes sharing an identical accessible name ("City") for one
 * field label, where only one is genuinely writable. `resolveDeepLocatorCandidates`
 * surfaces both under that shared name — matching-by-name alone can't tell
 * them apart — so it is `fillDeepLocatorCandidate`'s per-index write/read-back
 * verify (`writeAndVerify`, `deep-locator-actuate.ts`) that must honestly
 * report `false` against the non-committing duplicate and `true` against the
 * committing one, so a caller that excludes failed selectors and retries
 * (`flow-runner.ts`'s cascade) converges on the real field instead of a
 * false "written" against a phantom copy.
 */
describe("duplicate accessible-name candidates: write-verify distinguishes the committing node", () => {
  it("resolveDeepLocatorCandidates surfaces both same-named candidates, and fillDeepLocatorCandidate reports false for the non-committing one, true for the committing one", async () => {
    const hopSelector = `${FRAME_SELECTOR} >> input`;
    const frame: FakeDeepLocatorFrame = new Map();
    const hop = registerDeepLocatorHopElements(frame, hopSelector, [
      { text: "City", visible: true },
      { text: "City", visible: true },
    ]);
    // Element 0 is a duplicate copy whose write never commits (e.g. a
    // controlled component that reverts the value) — inputValue() always
    // reads back empty regardless of what fill() writes.
    const nonCommitting = hop.elements[0];
    if (!nonCommitting) throw new Error("test setup: expected element 0");
    nonCommitting.readBackValue = "";
    const page = { deepLocator: makeFakeDeepLocator(frame) };

    const candidates = await resolveDeepLocatorCandidates(
      // biome-ignore lint/suspicious/noExplicitAny: fake Page surface for the delegate contract under test
      page as any,
      FRAME_SELECTOR,
      "input"
    );
    expect(candidates.map((c) => c.accessibleText)).toEqual(["City", "City"]);

    const resultAgainstNonCommitting = await fillDeepLocatorCandidate(
      // biome-ignore lint/suspicious/noExplicitAny: fake Page surface for the delegate contract under test
      page as any,
      FRAME_SELECTOR,
      "input",
      candidates[0]?.index ?? 0,
      "Austin"
    );
    expect(resultAgainstNonCommitting).toBe(false);
    expect(hop.elements[1]?.filledWith).toBeNull();

    const resultAgainstCommitting = await fillDeepLocatorCandidate(
      // biome-ignore lint/suspicious/noExplicitAny: fake Page surface for the delegate contract under test
      page as any,
      FRAME_SELECTOR,
      "input",
      candidates[1]?.index ?? 1,
      "Austin"
    );
    expect(resultAgainstCommitting).toBe(true);
    expect(hop.elements[1]?.filledWith).toBe("Austin");
  });

  it("a batched frame-scoped write whose inline read-back disagrees degrades to the legacy delegate, which reports the non-committing duplicate's own honest fixture state", async () => {
    const hopSelector = `${FRAME_SELECTOR} >> input`;
    const frame: FakeDeepLocatorFrame = new Map();
    const hop = registerDeepLocatorHopElements(frame, hopSelector, [
      { text: "City", visible: true },
      { text: "City", visible: true },
    ]);
    const nonCommitting = hop.elements[0];
    if (!nonCommitting) throw new Error("test setup: expected element 0");
    nonCommitting.readBackValue = "";
    const page = { deepLocator: makeFakeDeepLocator(frame) };
    const frameTarget = {
      frame: {} as unknown as import("@/scraper/frame-target").FrameTarget["frame"],
      frameSelector: FRAME_SELECTOR,
      declaredFrameSelector: FRAME_SELECTOR,
      // Matches the real batched-write expression's own inline read-back —
      // it reports the write "committed" locally, the same non-committing
      // state the legacy delegate's separate inputValue() call would see.
      evaluate: async () => ({ written: true, readBack: "" }),
      locator: () => {
        throw new Error("locator() is not used by fillDeepLocatorCandidate");
      },
      url: async () => "",
      title: async () => "",
    };

    const result = await fillDeepLocatorCandidate(
      // biome-ignore lint/suspicious/noExplicitAny: fake Page surface for the delegate contract under test
      page as any,
      FRAME_SELECTOR,
      "input",
      0,
      "Austin",
      // biome-ignore lint/suspicious/noExplicitAny: minimal FrameTarget stub for the batched-write seam under test
      { frameTarget: frameTarget as any }
    );

    // The batched evaluate's own inline readBack ("") disagreeing with
    // "Austin" degrades to the legacy delegate write/read-back pair
    // (fillDeepLocatorCandidate's documented degrade contract) rather than
    // trusting the batched verdict outright — that separate delegate
    // read-back honestly reports this duplicate's non-committing fixture
    // state, so the caller never sees a false "written".
    expect(result).toBe(false);
  });

  it("a duplicate node whose write's OWN inline readBack agrees at write-time, but reverts by the time a second read lands, degrades to the legacy delegate instead of trusting the batched verdict", async () => {
    const hopSelector = `${FRAME_SELECTOR} >> input`;
    const frame: FakeDeepLocatorFrame = new Map();
    const hop = registerDeepLocatorHopElements(frame, hopSelector, [
      { text: "City", visible: true },
      { text: "City", visible: true },
    ]);
    // Element 0 models a controlled component whose onChange reverts the
    // value on a LATER tick — the write expression's own synchronous inline
    // readBack still observes the just-written value (it reads el.value in
    // the same task as the write), but any subsequent read observes the
    // reverted empty string, matching the bug report's "phantom-click" lead:
    // a copy that looks committed at write-time but never actually sticks.
    const nonCommitting = hop.elements[0];
    if (!nonCommitting) throw new Error("test setup: expected element 0");
    nonCommitting.readBackValue = "";
    const page = { deepLocator: makeFakeDeepLocator(frame) };
    let evaluateCallCount = 0;
    const frameTarget = {
      frame: {} as unknown as import("@/scraper/frame-target").FrameTarget["frame"],
      frameSelector: FRAME_SELECTOR,
      declaredFrameSelector: FRAME_SELECTOR,
      evaluate: async () => {
        evaluateCallCount += 1;
        // First call is the write expression: its inline readBack (read in
        // the same synchronous evaluate as the write) still sees "Austin".
        // Second call is the stuck-confirm re-check: it observes the
        // reverted value, since the fixture's readBackValue models a value
        // that reverts by the time of that later read.
        return evaluateCallCount === 1 ? { written: true, readBack: "Austin" } : { value: "" };
      },
      locator: () => {
        throw new Error("locator() is not used by fillDeepLocatorCandidate");
      },
      url: async () => "",
      title: async () => "",
    };

    const result = await fillDeepLocatorCandidate(
      // biome-ignore lint/suspicious/noExplicitAny: fake Page surface for the delegate contract under test
      page as any,
      FRAME_SELECTOR,
      "input",
      0,
      "Austin",
      // biome-ignore lint/suspicious/noExplicitAny: minimal FrameTarget stub for the batched-write seam under test
      { frameTarget: frameTarget as any }
    );

    // The stuck-confirm re-check disagreeing with "Austin", despite the
    // write's own inline readBack having agreed, degrades to the legacy
    // delegate write/read-back pair rather than trusting the batched
    // write's inline readBack outright — that separate delegate read-back
    // honestly reports this duplicate's non-committing fixture state, so
    // the caller never sees a false "written" for a value that reverted on
    // a tick the write's own synchronous evaluate call couldn't observe.
    expect(result).toBe(false);
    expect(evaluateCallCount).toBe(2);
  });
});
