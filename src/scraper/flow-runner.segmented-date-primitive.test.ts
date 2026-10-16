import type { Stagehand } from "@browserbasehq/stagehand";
import { describe, expect, it, vi } from "vitest";
import {
  executeStepWithHealing,
  runSegmentedDateSpinbuttonPrimitive,
  trySegmentedDateSpinbuttonPrimitive,
} from "@/scraper/flow-runner";
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
        return {
          groups: [
            {
              segmentMaxes: [12, 2099],
              context: "Start date From",
              label: "From",
              section: "Start date",
            },
          ],
        };
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
    expect(sent.some((s) => s.startsWith("Input.insertText"))).toBe(false);
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

describe("executeStepWithHealing segmented-date wiring", () => {
  it("completes via the primitive with no act call", async () => {
    const { target, page } = harness(true);
    const act = vi.fn();
    const stagehand = { act, observe: vi.fn().mockResolvedValue([]) } as unknown as Stagehand;
    const result = await executeStepWithHealing({
      stagehand,
      page,
      frameTarget: target,
      step: "Enter 'From' date '012020'",
      optional: false,
      upload: false,
      submitStep: false,
      stepIndex: 3,
      phase: "apply",
      signalCounter: { n: 0 },
      recentCaptures: [],
      recentCaptureMeta: [],
      anthropic: null,
      rephraseModel: null,
      logger,
      captureFn: vi.fn().mockResolvedValue(undefined),
      uploadFixture: null,
      isFinalStep: false,
      submitEndpointPattern: null,
      submittedStateSelectors: [],
      requireSubmitEndpointMatch: false,
      advanceTransitionBodyPattern: null,
      successUrlFragments: [],
      successPageTitleHints: [],
      ownBackendHostnames: [],
      knownErrorClassPrefixes: [],
      wizardExitButtonLabels: [],
    } as unknown as Parameters<typeof executeStepWithHealing>[0]);
    expect(result).toBe("completed");
    expect(act).not.toHaveBeenCalled();
  });
});

describe("runSegmentedDateSpinbuttonPrimitive refusal", () => {
  const group = (label: string): Record<string, unknown> => ({
    segmentMaxes: [12, 2099],
    context: "Start date",
    label,
    section: "Start date",
  });
  const build = (groups: unknown[], honourKeys: boolean): FrameTarget =>
    ({
      frame: null,
      frameSelector: null,
      evaluate: vi.fn(async (expr: string) => {
        if (expr.includes("aria-valuemax")) return { groups };
        if (expr.includes("aria-valuenow")) return honourKeys ? [1, 2020] : [0, 0];
        return undefined;
      }),
      locator: vi.fn(() => ({
        first() {
          return this;
        },
        click: async (): Promise<void> => {},
        type: vi.fn(async (): Promise<void> => {}),
      })),
    }) as unknown as FrameTarget;
  const page = { sendCDP: async (): Promise<void> => {} } as never;

  it("refuses on a readback mismatch", async () => {
    const out = await runSegmentedDateSpinbuttonPrimitive({
      page,
      target: build([group("From")], false),
      instruction: "Enter 'From' date '012020'",
      logger,
    });
    expect(out.kind).toBe("refused");
  });

  it("refuses when two compatible groups tie", async () => {
    const out = await runSegmentedDateSpinbuttonPrimitive({
      page,
      target: build([group("Date"), group("Date")], true),
      instruction: "Enter date '012020'",
      logger,
    });
    expect(out.kind).toBe("refused");
  });

  it("is not-applicable when no group is width-compatible", async () => {
    const out = await runSegmentedDateSpinbuttonPrimitive({
      page,
      target: build([group("From")], true),
      instruction: "Enter 'From' date '01202099'",
      logger,
    });
    expect(out.kind).toBe("not-applicable");
  });

  it("is not-applicable with no spinbuttons", async () => {
    const out = await runSegmentedDateSpinbuttonPrimitive({
      page,
      target: build([], true),
      instruction: "Enter 'From' date '012020'",
      logger,
    });
    expect(out.kind).toBe("not-applicable");
  });
});
