import { describe, expect, it } from "vitest";
import { fillDeepLocatorCandidate } from "@/scraper/deep-locator-actuate";
import { resolveDeepLocatorCandidates } from "@/scraper/deep-locator-candidates";
import {
  type FakeDeepLocatorFrame,
  makeFakeDeepLocator,
  registerDeepLocatorHopElements,
} from "@/scraper/deep-locator-fake";

const FRAME_SELECTOR = "#talemetry_apply_iframe";

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
      // Mirrors the real batched-write expression's own inline read-back —
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
});
