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

import {
  fillTextDatepickerInput,
  isDateSegmentAtSelector,
  verifyFillReadback,
  dispatchJqueryChangeEvent,
} from "./flow-runner.js";

describe("frame-relative xpath reaches in-frame evaluate", () => {
  const composite = "/html[1]/body[1]/main[1]/iframe[1]/html[1]/body[1]/div[2]/input[1]";
  const rel = "/html[1]/body[1]/div[2]/input[1]";
  function fake() {
    const exprs: string[] = [];
    const t = {
      frame: {},
      frameSelector: "iframe#f",
      evaluate: async (e: unknown) => {
        exprs.push(String(e));
        return null;
      },
    } as unknown as FrameTarget;
    return { t, exprs };
  }
  const check = (exprs: string[]) => {
    expect(exprs.length).toBeGreaterThan(0);
    for (const e of exprs) {
      expect(e).toContain(JSON.stringify(rel));
      expect(e).not.toContain("iframe[1]");
    }
  };
  it("isDateSegmentAtSelector", async () => {
    const { t, exprs } = fake();
    await isDateSegmentAtSelector(t, `xpath=${composite}`).catch(() => false);
    check(exprs);
  });
  it("verifyFillReadback", async () => {
    const { t, exprs } = fake();
    await verifyFillReadback(t, `xpath=${composite}`, "x").catch(() => null);
    check(exprs);
  });
  it("dispatchJqueryChangeEvent", async () => {
    const { t, exprs } = fake();
    await dispatchJqueryChangeEvent(t, `xpath=${composite}`).catch(() => undefined);
    check(exprs);
  });
  it("fillTextDatepickerInput", async () => {
    const { t, exprs } = fake();
    await fillTextDatepickerInput(t, `xpath=${composite}`, "01/02/2024").catch(() => null);
    check(exprs);
  });
});
