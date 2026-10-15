import { describe, expect, it, vi } from "vitest";
import {
  resolveSegmentedDateGroup,
  type SegmentedDateGroup,
  trySegmentedDateSpinbuttonPrimitive,
  verifyDomEffect,
} from "@/scraper/flow-runner";
import type { FrameTarget } from "@/scraper/frame-target";

const GROUPS: SegmentedDateGroup[] = [
  { segmentMaxes: [12, 9999], context: "Work Experience 1 From" },
  { segmentMaxes: [12, 9999], context: "Work Experience 1 To" },
  { segmentMaxes: [9999], context: "Education 1 From" },
  { segmentMaxes: [9999], context: "Education 1 To" },
];

const WORK_FROM = "'From' date in Work Experience 1, '012020'";
const EDU_FROM = "'From' date of Education 1, '2016'";
const EDU_TO = "'To' date of Education 1, '2020'";

function harness(
  groups: SegmentedDateGroup[],
  readback: number[]
): {
  target: FrameTarget;
  page: never;
  sent: string[];
  exprs: string[];
} {
  const sent: string[] = [];
  const exprs: string[] = [];
  const target = {
    frame: null,
    frameSelector: null,
    evaluate: vi.fn(async (expr: string) => {
      exprs.push(expr);
      if (expr.includes("aria-valuemax")) return { groups };
      if (expr.includes("scrollIntoView")) return { state: "hit" };
      if (expr.includes("aria-valuenow")) return readback;
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
    sendCDP: async (m: string, a: { type: string }) => {
      sent.push(`${m}:${a.type}`);
    },
  } as never;
  return { target, page, sent, exprs };
}

const logger = { info: vi.fn(), warn: vi.fn() } as never;

describe("segmented date group resolution (verbatim steps)", () => {
  it("resolves each step to the expected group", () => {
    expect(resolveSegmentedDateGroup(WORK_FROM, GROUPS)).toBe(0);
    expect(resolveSegmentedDateGroup(EDU_FROM, GROUPS)).toBe(2);
    expect(resolveSegmentedDateGroup(EDU_TO, GROUPS)).toBe(3);
  });

  it("returns null on an equal-score tie", () => {
    const tied = [GROUPS[0], GROUPS[0]] as SegmentedDateGroup[];
    expect(resolveSegmentedDateGroup(WORK_FROM, tied)).toBeNull();
  });

  it("returns null when the digit count fits no group", () => {
    expect(
      resolveSegmentedDateGroup("'From' date in Work Experience 1, '75201'", GROUPS)
    ).toBeNull();
  });
});

describe("segmented date primitive", () => {
  it("types the resolved group's digits and commits", async () => {
    const { target, page, sent } = harness(GROUPS, [1, 2020]);
    const id = await trySegmentedDateSpinbuttonPrimitive({
      page,
      target,
      logger,
      instruction: WORK_FROM,
    });
    expect(id).toBe("segmented-date-0");
    expect(sent.filter((s) => s.endsWith("keyDown"))).toHaveLength(6);
  });

  it("types '012020' as ordered per-digit key events, never insertText or fill", async () => {
    const calls: { method: string; args: { type: string; text?: string } }[] = [];
    const { target, exprs } = harness(GROUPS, [1, 2020]);
    const page = {
      sendCDP: async (method: string, args: { type: string; text?: string }) => {
        calls.push({ method, args });
      },
    } as never;
    const fill = vi.fn();
    (
      target.locator as unknown as { mockImplementation: (f: () => unknown) => void }
    ).mockImplementation(() => {
      const loc = { first: () => loc, click: async (): Promise<void> => {}, fill, type: fill };
      return loc;
    });
    const id = await trySegmentedDateSpinbuttonPrimitive({
      page,
      target,
      logger,
      instruction: WORK_FROM,
    });
    expect(id).toBe("segmented-date-0");
    expect(calls.every((c) => c.method === "Input.dispatchKeyEvent")).toBe(true);
    const downs = calls.filter((c) => c.args.type === "keyDown").map((c) => c.args.text);
    expect(downs).toEqual(["0", "1", "2", "0", "2", "0"]);
    for (let i = 0; i < calls.length; i += 1) {
      if (calls[i]?.args.type === "keyDown") {
        expect(calls[i + 1]?.args.type).toBe("keyUp");
      }
    }
    expect(calls.some((c) => c.method === "Input.insertText")).toBe(false);
    expect(fill).not.toHaveBeenCalled();
    expect(exprs.some((e) => e.includes(".value ="))).toBe(false);
  });

  it("returns null when readback differs from the typed digits", async () => {
    const { target, page } = harness(GROUPS, [1, 2021]);
    expect(
      await trySegmentedDateSpinbuttonPrimitive({ page, target, logger, instruction: WORK_FROM })
    ).toBeNull();
  });

  it("dispatches no key events for '75201' against an MM/YYYY group", async () => {
    const { target, page, sent } = harness([GROUPS[0] as SegmentedDateGroup], [1, 2020]);
    const id = await trySegmentedDateSpinbuttonPrimitive({
      page,
      target,
      logger,
      instruction: "'From' date in Work Experience 1, '75201'",
    });
    expect(id).toBeNull();
    expect(sent).toHaveLength(0);
  });

  it("returns null when segments ignore key events", async () => {
    const { target, page } = harness(GROUPS, [0, 0]);
    expect(
      await trySegmentedDateSpinbuttonPrimitive({ page, target, logger, instruction: WORK_FROM })
    ).toBeNull();
  });

  it("returns null with no key events or DOM writes when no spinbutton exists", async () => {
    const { target, page, sent, exprs } = harness([], []);
    expect(
      await trySegmentedDateSpinbuttonPrimitive({ page, target, logger, instruction: WORK_FROM })
    ).toBeNull();
    expect(sent).toHaveLength(0);
    expect(exprs).toHaveLength(1);
    expect(exprs[0]).toContain("aria-valuemax");
  });
});

describe("lone spinbutton segment verification", () => {
  function segmentTarget(): { target: FrameTarget; fill: ReturnType<typeof vi.fn> } {
    const fill = vi.fn();
    const locator = {
      first: () => locator,
      inputValue: async (): Promise<string> => "01",
      fill,
      type: vi.fn(),
    };
    const target = {
      evaluate: async (): Promise<unknown> => ({
        outcome: "segment",
        postValue: "01",
        tag: "input",
      }),
      locator: () => locator,
    } as unknown as FrameTarget;
    return { target, fill };
  }

  it.each([
    ["type '01' into Month", "01"],
    ["type '2020' into Year", "2020"],
  ])("does not credit %s off a lone segment", async (description, value) => {
    const { target, fill } = segmentTarget();
    const ok = await verifyDomEffect(target, {
      selector: "xpath=//input[1]",
      method: "fill",
      arguments: [value],
      description,
    } as never);
    expect(ok).toBe(false);
    expect(fill).not.toHaveBeenCalled();
  });
});
