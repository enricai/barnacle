import { describe, expect, it } from "vitest";
import { isContentRemovalCredited } from "./flow-runner.js";

describe("isContentRemovalCredited with unreadable presence", () => {
  const base = { bytesDelta: -800, textChanged: true, textShrunk: true };
  it("credits a measured text shrink when presence is unknown and action unreported", () => {
    expect(
      isContentRemovalCredited({
        ...base,
        method: null,
        clickedElementStillPresent: true,
        presenceUnknown: true,
      })
    ).toBe(true);
  });
  it("still vetoes a target positively present", () => {
    expect(
      isContentRemovalCredited({ ...base, method: "click", clickedElementStillPresent: true })
    ).toBe(false);
  });
  it("does not credit unknown presence without a text shrink", () => {
    expect(
      isContentRemovalCredited({
        ...base,
        textShrunk: false,
        textChanged: false,
        method: "click",
        clickedElementStillPresent: true,
        presenceUnknown: true,
      })
    ).toBe(false);
  });
});
