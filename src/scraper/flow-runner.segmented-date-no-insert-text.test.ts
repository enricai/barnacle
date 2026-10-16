// @vitest-environment happy-dom
import type { Stagehand } from "@browserbasehq/stagehand";
import { describe, expect, it, vi } from "vitest";
import { executeStepWithHealing, runSegmentedDateSpinbuttonPrimitive } from "@/scraper/flow-runner";
import type { FrameTarget } from "@/scraper/frame-target";

type El = {
  value: string;
  getAttribute: (n: string) => string | null;
  setAttribute: (n: string, v: string) => void;
};
type Doc = {
  body: { innerHTML: string };
  activeElement: El | null;
  querySelector: (s: string) => unknown;
};

const doc = (): Doc => (globalThis as unknown as { document: Doc }).document;

const seg = (id: string, max: number, label: string): string =>
  `<div><input id="${id}" role="spinbutton" aria-label="${label}" aria-valuemax="${max}" /></div>`;
const monthYear = (p: string): string => seg(`${p}-m`, 12, "Month") + seg(`${p}-y`, 9999, "Year");
const section = (title: string, label: string, segs: string): string =>
  `<section><h3>${title}</h3><div role="group" aria-label="${label}">${segs}</div></section>`;

const PERIODS =
  section("Billing 1", "From", monthYear("bf")) +
  section("Billing 1", "To", monthYear("bt")) +
  section("Plan 1", "From", seg("pf-y", 9999, "Year")) +
  section("Plan 1", "To", seg("pt-y", 9999, "Year"));

const LONE = section("Dates", "Period", monthYear("bf"));

const logger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn() } as never;

interface Spies {
  fill: ReturnType<typeof vi.fn>;
  insertText: ReturnType<typeof vi.fn>;
  act: ReturnType<typeof vi.fn>;
  observe: ReturnType<typeof vi.fn>;
  cdp: string[];
}

function harness(honourKeys: boolean): { target: FrameTarget; page: never; spies: Spies } {
  const spies: Spies = {
    fill: vi.fn(async (): Promise<void> => {}),
    insertText: vi.fn(async (): Promise<void> => {}),
    act: vi.fn(),
    observe: vi.fn().mockResolvedValue([]),
    cdp: [],
  };
  const target = {
    frame: null,
    frameSelector: null,
    evaluate: async (expr: string): Promise<unknown> => new Function(`return ${expr}`)(),
    locator: () => ({
      first() {
        return this;
      },
      click: async (): Promise<void> => {},
      type: vi.fn(),
      fill: spies.fill,
      insertText: spies.insertText,
    }),
  } as unknown as FrameTarget;
  const page = {
    sendCDP: async (m: string, a: { type?: string; text?: string }): Promise<void> => {
      spies.cdp.push(m);
      if (m !== "Input.dispatchKeyEvent" || a.type !== "keyDown" || !honourKeys) return;
      const el = doc().activeElement;
      if (el?.getAttribute("role") !== "spinbutton") return;
      el.value = `${el.value}${a.text}`;
      el.setAttribute("aria-valuenow", String(Number(el.value)));
    },
  } as never;
  return { target, page, spies };
}

function install(html: string): void {
  doc().body.innerHTML = html;
  (globalThis as unknown as Record<string, unknown>).XPathResult = { FIRST_ORDERED_NODE_TYPE: 9 };
}

async function runStep(
  step: string,
  h: ReturnType<typeof harness>
): Promise<"completed" | "failed"> {
  const stagehand = { act: h.spies.act, observe: h.spies.observe } as unknown as Stagehand;
  try {
    return (await executeStepWithHealing({
      stagehand,
      page: h.page,
      frameTarget: h.target,
      step,
      optional: false,
      upload: false,
      submitStep: false,
      stepIndex: 1,
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
    } as unknown as Parameters<typeof executeStepWithHealing>[0])) as "completed";
  } catch {
    return "failed";
  }
}

const noWrites = (s: Spies): void => {
  expect(s.fill).not.toHaveBeenCalled();
  expect(s.insertText).not.toHaveBeenCalled();
  expect(s.cdp).not.toContain("Input.insertText");
  expect(s.act).not.toHaveBeenCalled();
  expect(s.observe).not.toHaveBeenCalled();
};

const val = (id: string): string =>
  (doc().querySelector(`#${id}`) as unknown as { value: string }).value;

describe("segmented date steps never deliver via insertText/fill", () => {
  it.each([
    ["'From' date in Billing 1, '012020'", { "bf-m": "01", "bf-y": "2020" }],
    ["'From' date of Plan 1, '2016'", { "pf-y": "2016" }],
    ["'To' date of Plan 1, '2020'", { "pt-y": "2020" }],
  ])("%s is typed per segment on a multi-segment page", async (step, expected) => {
    install(PERIODS);
    const h = harness(true);
    expect(await runStep(step, h)).toBe("completed");
    noWrites(h.spies);
    for (const [id, v] of Object.entries(expected)) expect(val(id)).toBe(v);
  });

  it.each(["type '01' into Month", "type '2020' into Year", "type '012020'"])(
    "%s on a lone widget bypasses fill, act and observe",
    async (step) => {
      install(LONE);
      const h = harness(true);
      expect(await runStep(step, h)).toBe("completed");
      noWrites(h.spies);
    }
  );

  it.each([
    "'From' date in Billing 1, '012020'",
    "'From' date of Plan 1, '2016'",
    "'To' date of Plan 1, '2020'",
  ])("%s fails the step without any write when keys are ignored", async (step) => {
    install(PERIODS);
    const h = harness(false);
    expect(await runStep(step, h)).toBe("failed");
    noWrites(h.spies);
  });
});

describe("non-date inputs are unaffected", () => {
  const quantity = `<label for="q">Quantity</label><input id="q" role="spinbutton" aria-valuemax="99" />`;
  const name = `<label for="n">Name</label><input id="n" type="text" />`;

  it.each([
    ["single non-date spinbutton", quantity, "type '5' into Quantity"],
    ["text field", name, "type 'Ada' into Name"],
  ])("%s is not claimed by the segmented-date primitive", async (_n, html, instruction) => {
    install(html);
    const h = harness(true);
    const out = await runSegmentedDateSpinbuttonPrimitive({
      page: h.page,
      target: h.target,
      instruction,
      logger,
    });
    expect(out.kind).toBe("not-applicable");
    expect(h.spies.cdp).toEqual([]);
  });
});
