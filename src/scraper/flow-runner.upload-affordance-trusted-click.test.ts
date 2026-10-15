import type { Page } from "@browserbasehq/stagehand";
import { describe, expect, it, vi } from "vitest";

import { clickUploadAffordance } from "@/scraper/flow-runner";
import type { FrameTarget } from "@/scraper/frame-target";
import type { Logger } from "@/types/logging";

const MARKER = "data-barnacle-upload-affordance";

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

function fakeTarget(
  click: () => Promise<void>,
  hit: "hit" | "occluded" = "hit"
): { target: FrameTarget; calls: string[] } {
  const calls: string[] = [];
  const target = {
    frame: {},
    evaluate: (expr: unknown): Promise<unknown> => {
      const e = String(expr);
      calls.push(e);
      if (e.includes("scrollIntoView")) return Promise.resolve({ state: hit, occluder: "div" });
      return Promise.resolve(
        e.includes("removeAttribute") ? undefined : { marked: true, text: "upload" }
      );
    },
    locator: (sel: string) => ({
      click: () => {
        calls.push(`click ${sel}`);
        return click();
      },
    }),
  } as unknown as FrameTarget;
  return { target, calls };
}

const page = { waitForTimeout: () => Promise.resolve() } as unknown as Page;

describe("clickUploadAffordance trusted click", () => {
  it("clicks once via locator on the marker selector, never el.click(), then removes the marker", async () => {
    const click = vi.fn().mockResolvedValue(undefined);
    const { target, calls } = fakeTarget(click);
    const ok = await clickUploadAffordance(page, target, logger);
    expect(ok).toBe(true);
    expect(click).toHaveBeenCalledTimes(1);
    expect(calls.filter((c) => c.startsWith("click "))).toEqual([`click [${MARKER}]`]);
    const pick = calls.find((c) => c.includes("chosen.setAttribute("));
    expect(pick).toContain(`setAttribute("${MARKER}"`);
    expect(pick).not.toMatch(/\.click\(\)/);
    const clickIdx = calls.indexOf(`click [${MARKER}]`);
    const removeIdx = calls.findIndex((c) => c.includes("removeAttribute"));
    expect(removeIdx).toBeGreaterThan(clickIdx);
    expect(calls[removeIdx]).toContain(MARKER);
  });

  it("removes the marker and returns false when the click throws", async () => {
    const click = vi.fn().mockRejectedValue(new Error("boom"));
    const { target, calls } = fakeTarget(click);
    const ok = await clickUploadAffordance(page, target, logger);
    expect(ok).toBe(false);
    expect(click).toHaveBeenCalledTimes(1);
    expect(calls[calls.length - 1]).toContain("removeAttribute");
  });

  it("centres and hit-tests before the click", async () => {
    const click = vi.fn().mockResolvedValue(undefined);
    const { target, calls } = fakeTarget(click);
    await clickUploadAffordance(page, target, logger);
    const centreIdx = calls.findIndex((c) => c.includes("scrollIntoView"));
    expect(centreIdx).toBeGreaterThanOrEqual(0);
    expect(calls[centreIdx]).toContain(MARKER);
    expect(centreIdx).toBeLessThan(calls.indexOf(`click [${MARKER}]`));
  });

  it("never clicks an occluded marker, removes it, and returns false", async () => {
    const click = vi.fn().mockResolvedValue(undefined);
    const { target, calls } = fakeTarget(click, "occluded");
    const ok = await clickUploadAffordance(page, target, logger);
    expect(ok).toBe(false);
    expect(click).not.toHaveBeenCalled();
    expect(calls[calls.length - 1]).toContain("removeAttribute");
  });
});
