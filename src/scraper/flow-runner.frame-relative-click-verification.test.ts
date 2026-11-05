import { describe, expect, it } from "vitest";
import { toFrameRelativeXpath } from "./flow-runner.js";
import type { FrameTarget } from "./frame-target.js";

const frameTarget = { frame: {}, frameSelector: "iframe#f" } as unknown as FrameTarget;
const mainTarget = { frame: null, frameSelector: null } as unknown as FrameTarget;

describe("toFrameRelativeXpath", () => {
  const composite =
    "/html[1]/body[1]/main[1]/div[1]/div[1]/span[1]/iframe[1]/html[1]/body[1]/div[2]/div[3]/a[1]";
  it("strips the iframe prefix for a frame target", () => {
    expect(toFrameRelativeXpath(composite, frameTarget)).toBe("/html[1]/body[1]/div[2]/div[3]/a[1]");
    expect(
      toFrameRelativeXpath("/html[1]/body[1]/main[1]/iframe[1]/html[1]/body[1]/div[2]/a[1]", frameTarget)
    ).toBe("/html[1]/body[1]/div[2]/a[1]");
  });
  it("leaves main-document targets and iframe-free paths unchanged", () => {
    expect(toFrameRelativeXpath(composite, mainTarget)).toBe(composite);
    expect(toFrameRelativeXpath(composite)).toBe(composite);
    expect(toFrameRelativeXpath("/html[1]/body[1]/div[2]/a[1]", frameTarget)).toBe(
      "/html[1]/body[1]/div[2]/a[1]"
    );
  });
});
