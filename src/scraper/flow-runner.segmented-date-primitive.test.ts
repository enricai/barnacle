import { describe, expect, it, vi } from "vitest";
import { trySegmentedDateSpinbuttonPrimitive } from "@/scraper/flow-runner";
import type { FrameTarget } from "@/scraper/frame-target";

function harness(honourKeys: boolean): {
  target: FrameTarget;
  page: never;
  sent: string[];
} {
  const sent: string[] = [];
  const typed: string[] = [];
  const target = {
    frame: null,
    frameSelector: null,
    evaluate: vi.fn(async (expr: string) => {
      if (expr.includes("aria-valuemax")) {
        return { groups: [{ segmentMaxes: [12, 2099], context: "Start date From" }] };
      }
      if (expr.includes("scrollIntoView")) return { state: "hit" };
      if (expr.includes("aria-valuenow")) return honourKeys ? [1, 2020] : [0, 0];
      return undefined;
    }),
    locator: vi.fn(() => ({
      first() {
        return this;
      },
      click: async (): Promise<void> => {},
    })),
  } as unknown as FrameTarget;
  const page = {
    sendCDP: async (m: string, a: { type: string; text?: string }) => {
      sent.push(`${m}:${a.type}`);
      if (a.text) typed.push(a.text);
    },
  } as never;
  return { target, page, sent };
}

const logger = { info: vi.fn(), warn: vi.fn() } as never;

describe("trySegmentedDateSpinbuttonPrimitive", () => {
  it("commits via key events when segments honour them", async () => {
    const { target, page, sent } = harness(true);
    const id = await trySegmentedDateSpinbuttonPrimitive({
      page,
      target,
      logger,
      instruction: "Enter 'From' date '012020'",
    });
    expect(id).not.toBeNull();
    expect(sent.filter((s) => s.endsWith("keyDown"))).toHaveLength(6);
  });

  it("returns null when segments ignore key events", async () => {
    const { target, page } = harness(false);
    expect(
      await trySegmentedDateSpinbuttonPrimitive({
        page,
        target,
        logger,
        instruction: "Enter 'From' date '012020'",
      })
    ).toBeNull();
  });
});
