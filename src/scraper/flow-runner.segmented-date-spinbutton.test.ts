import { describe, expect, it, vi } from "vitest";
import {
  resolveSegmentedDateGroup,
  type SegmentedDateGroup,
  trySegmentedDateSpinbuttonPrimitive,
  verifyDomEffect,
} from "@/scraper/flow-runner";
import type { FrameTarget } from "@/scraper/frame-target";

const GROUPS: SegmentedDateGroup[] = [
  {
    segmentMaxes: [12, 9999],
    context: "Work Experience 1 From",
    label: "From",
    section: "Work Experience 1",
  },
  {
    segmentMaxes: [12, 9999],
    context: "Work Experience 1 To",
    label: "To",
    section: "Work Experience 1",
  },
  { segmentMaxes: [9999], context: "Education 1 From", label: "From", section: "Education 1" },
  { segmentMaxes: [9999], context: "Education 1 To", label: "To", section: "Education 1" },
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

  it("re-focuses the next segment when the widget does not auto-advance", async () => {
    const { target, page } = harness(GROUPS, [1, 2020]);
    const base = target.evaluate as unknown as (expr: string) => Promise<unknown>;
    (target as unknown as { evaluate: (expr: string) => Promise<unknown> }).evaluate = async (
      expr: string
    ) => {
      if (expr.includes("document.activeElement")) return "0:0";
      return base(expr);
    };
    const id = await trySegmentedDateSpinbuttonPrimitive({
      page,
      target,
      logger,
      instruction: WORK_FROM,
    });
    expect(id).toBe("segmented-date-0");
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

  it("scrolls the first segment into view before any key event is sent", async () => {
    const order: string[] = [];
    const { target } = harness(GROUPS, [1, 2020]);
    const base = target.evaluate as unknown as (expr: string) => Promise<unknown>;
    (target as unknown as { evaluate: (expr: string) => Promise<unknown> }).evaluate = async (
      expr: string
    ) => {
      if (expr.includes('scrollIntoView({ block: "center"') && expr.includes("0:0")) {
        order.push("scroll");
      }
      return base(expr);
    };
    const page = {
      sendCDP: async (_m: string, a: { type: string }) => {
        order.push(a.type);
      },
    } as never;
    await trySegmentedDateSpinbuttonPrimitive({ page, target, logger, instruction: WORK_FROM });
    expect(order[0]).toBe("scroll");
    expect(order.indexOf("scroll")).toBeLessThan(order.indexOf("keyDown"));
  });

  it("types nothing when the targeted field's own label is not among the groups", async () => {
    const { target, page, sent } = harness([GROUPS[1] as SegmentedDateGroup], [1, 2020]);
    const id = await trySegmentedDateSpinbuttonPrimitive({
      page,
      target,
      logger,
      instruction: WORK_FROM,
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

describe("segmented date primitive delivery", () => {
  it("falls back to a delayed locator.type per segment, never fill or insertText", async () => {
    const { target, sent } = harness(GROUPS, [1, 2020]);
    const page = {
      sendCDP: async (): Promise<void> => {
        throw new Error("cdp channel unavailable");
      },
    } as never;
    const selectors: string[] = [];
    const typed: { text: string; delay?: number }[] = [];
    const fill = vi.fn();
    (
      target.locator as unknown as { mockImplementation: (f: (s: string) => unknown) => void }
    ).mockImplementation((selector: string) => {
      const loc = {
        first: () => loc,
        click: async (): Promise<void> => {},
        fill,
        type: async (text: string, opts?: { delay?: number }): Promise<void> => {
          selectors.push(selector);
          typed.push({ text, delay: opts?.delay });
        },
      };
      return loc;
    });
    const id = await trySegmentedDateSpinbuttonPrimitive({
      page,
      target,
      logger,
      instruction: "type '012020' into the Work Experience 1 'From' date",
    });
    expect(id).toBe("segmented-date-0");
    expect(typed.map((t) => t.text)).toEqual(["01", "2020"]);
    expect(typed.every((t) => (t.delay ?? 0) > 0)).toBe(true);
    expect(selectors).toHaveLength(2);
    expect(new Set(selectors).size).toBe(2);
    expect(fill).not.toHaveBeenCalled();
    expect(sent).toHaveLength(0);
  });

  it("accepts an unquoted value in the step", async () => {
    const { target, page } = harness(GROUPS, [1, 2020]);
    const id = await trySegmentedDateSpinbuttonPrimitive({
      page,
      target,
      logger,
      instruction: "Enter 012020 as the Work Experience 1 'From' date",
    });
    expect(id).toBe("segmented-date-0");
  });
});

describe("segmented date primitive obscured click point", () => {
  function obscuredFixture(opts: { popupOpen: boolean; escapeClearsPopup: boolean }): {
    target: FrameTarget;
    page: never;
    events: string[];
  } {
    const events: string[] = [];
    let popupOpen = opts.popupOpen;
    const { target: base } = harness(GROUPS, [1, 2020]);
    const baseEvaluate = base.evaluate as unknown as (expr: string) => Promise<unknown>;
    const target = {
      frame: null,
      frameSelector: null,
      evaluate: vi.fn(async (expr: string) => {
        if (expr.includes("elementFromPoint")) {
          events.push(popupOpen ? "hit-test:occluded" : "hit-test:hit");
          return popupOpen ? { state: "occluded", occluder: "ul#popup" } : { state: "hit" };
        }
        if (expr.includes("activeListContainer")) return popupOpen ? 1 : 0;
        if (expr.includes("el.focus()")) events.push("focus");
        return baseEvaluate(expr);
      }),
      locator: vi.fn(() => ({
        first() {
          return this;
        },
        click: async (): Promise<void> => {
          events.push("click");
        },
      })),
    } as unknown as FrameTarget;
    const page = {
      sendCDP: async (_m: string, a: { type: string; key: string }) => {
        if (a.type === "keyDown" && a.key === "Escape") {
          events.push("escape");
          if (opts.escapeClearsPopup) popupOpen = false;
          return;
        }
        if (a.type === "keyDown") events.push(`digit:${a.key}`);
      },
      waitForTimeout: async (): Promise<void> => undefined,
    } as never;
    return { target, page, events };
  }

  it("dismisses the obscuring popup, then trusted-clicks and types the digits", async () => {
    const { target, page, events } = obscuredFixture({ popupOpen: true, escapeClearsPopup: true });
    const id = await trySegmentedDateSpinbuttonPrimitive({
      page,
      target,
      logger,
      instruction: WORK_FROM,
    });
    expect(id).toBe("segmented-date-0");
    const escapeAt = events.indexOf("escape");
    const click = events.indexOf("click");
    const firstDigit = events.findIndex((e) => e.startsWith("digit:"));
    expect(escapeAt).toBeGreaterThanOrEqual(0);
    expect(click).toBeGreaterThan(escapeAt);
    expect(firstDigit).toBeGreaterThan(click);
    expect(events.filter((e) => e.startsWith("digit:")).map((e) => e.slice(6))).toEqual([
      "0",
      "1",
      "2",
      "0",
      "2",
      "0",
    ]);
  });

  it("issues no dismissal when the click point is already unobscured", async () => {
    const { target, page, events } = obscuredFixture({ popupOpen: false, escapeClearsPopup: true });
    const id = await trySegmentedDateSpinbuttonPrimitive({
      page,
      target,
      logger,
      instruction: WORK_FROM,
    });
    expect(id).toBe("segmented-date-0");
    expect(events).not.toContain("escape");
    expect(events).toContain("click");
  });

  it("withholds the trusted click and falls back to focus when dismissal fails", async () => {
    const { target, page, events } = obscuredFixture({ popupOpen: true, escapeClearsPopup: false });
    const id = await trySegmentedDateSpinbuttonPrimitive({
      page,
      target,
      logger,
      instruction: WORK_FROM,
    });
    expect(events).toContain("escape");
    expect(events).not.toContain("click");
    expect(events).toContain("focus");
    expect(id).toBe("segmented-date-0");
  });
});
