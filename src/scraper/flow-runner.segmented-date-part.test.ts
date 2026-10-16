import { describe, expect, it, vi } from "vitest";
import {
  parseSegmentedPartStep,
  trySegmentedDateSpinbuttonPrimitive,
} from "@/scraper/flow-runner";
import type { FrameTarget } from "@/scraper/frame-target";

function harness(honourKeys: boolean): { target: FrameTarget; page: never; sent: string[] } {
  const sent: string[] = [];
  const target = {
    frame: null,
    frameSelector: null,
    evaluate: vi.fn(async (expr: string) => {
      if (expr.includes("aria-valuemax")) {
        return {
          groups: [
            {
              segmentMaxes: [12, 9999],
              context: "Start date",
              label: "Start date",
              segmentLabels: ["Month", "Year"],
            },
          ],
        };
      }
      if (expr.includes("scrollIntoView")) return { state: "hit" };
      if (expr.includes("aria-valuenow")) {
        const k = expr.includes(':1"]') ? 1 : 0;
        return honourKeys ? [k === 1 ? 2020 : 1] : [Number.NaN];
      }
      return undefined;
    }),
    locator: vi.fn(() => ({
      first() {
        return this;
      },
      click: async (): Promise<void> => {},
      type: async (): Promise<void> => {},
    })),
  } as unknown as FrameTarget;
  const page = {
    sendCDP: async (m: string, a: { type: string }) => {
      sent.push(`${m}:${a.type}`);
    },
  } as never;
  return { target, page, sent };
}

const logger = { info: vi.fn(), warn: vi.fn() } as never;

describe("per-segment steps", () => {
  it("parses only label-bearing short values", () => {
    expect(parseSegmentedPartStep("type '01' into Month")?.part).toBe("month");
    expect(parseSegmentedPartStep("type '2020' into Year")?.part).toBe("year");
    expect(parseSegmentedPartStep("type '5551234567' into Year")).toBeNull();
    expect(parseSegmentedPartStep("type '01' into the field")).toBeNull();
  });

  it("delivers key events to the owning segment", async () => {
    const { target, page, sent } = harness(true);
    const id = await trySegmentedDateSpinbuttonPrimitive({
      page,
      target,
      logger,
      instruction: "type '2020' into Year",
    });
    expect(id).not.toBeNull();
    expect(sent.filter((s) => s.endsWith("keyDown"))).toHaveLength(4);
  });

  it("returns null when keys are ignored", async () => {
    const { target, page } = harness(false);
    const id = await trySegmentedDateSpinbuttonPrimitive({
      page,
      target,
      logger,
      instruction: "type '01' into Month",
    });
    expect(id).toBeNull();
  });

  it("returns null for too-wide value or no part label", async () => {
    const { target, page, sent } = harness(true);
    for (const instruction of ["type '75201' into Year", "type '01' into Foo"]) {
      expect(
        await trySegmentedDateSpinbuttonPrimitive({ page, target, logger, instruction })
      ).toBeNull();
    }
    expect(sent).toHaveLength(0);
  });
});
