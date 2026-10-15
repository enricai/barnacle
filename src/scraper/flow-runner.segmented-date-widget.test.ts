// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { executeStepWithHealing, trySegmentedDateSpinbuttonPrimitive } from "@/scraper/flow-runner";
import type { FrameTarget } from "@/scraper/frame-target";

interface El {
  getAttribute: (n: string) => string | null;
  setAttribute: (n: string, v: string) => void;
  addEventListener: (t: string, f: (e: Event) => void) => void;
  dispatchEvent: (e: unknown) => boolean;
  focus: () => void;
  parentElement: El | null;
  querySelectorAll: (s: string) => Iterable<El>;
}
interface Doc {
  body: { innerHTML: string };
  activeElement: El | null;
  querySelectorAll: (s: string) => Iterable<El>;
}
const KeyboardEventCtor = (
  globalThis as unknown as { KeyboardEvent: new (t: string, i: object) => unknown }
).KeyboardEvent;
const doc = (): Doc => (globalThis as unknown as { document: Doc }).document;

function section(id: string, title: string, label: string, maxes: number[]): string {
  const spins = maxes
    .map((m) => `<input role="spinbutton" aria-valuemax="${m}" data-max="${m}" />`)
    .join("");
  return `<section aria-labelledby="${id}"><h3 id="${id}">${title}</h3><div role="group" aria-label="${label}">${spins}</div></section>`;
}

/** Wires each spinbutton's own keydown handler: it only ever sees key events, never inserted text. */
function wireWidget(): void {
  for (const el of doc().querySelectorAll("input[role='spinbutton']")) {
    const max = Number(el.getAttribute("data-max"));
    const width = String(max).length;
    let typed = "";
    el.addEventListener("keydown", (e: Event) => {
      const key = (e as unknown as { key: string }).key;
      if (!/^\d$/.test(key)) return;
      typed = typed.length >= width ? key : typed + key;
      el.setAttribute("aria-valuenow", String(Number(typed)));
      if (typed.length === width) {
        const all = Array.from(el.parentElement?.querySelectorAll("input") ?? []);
        all[all.indexOf(el) + 1]?.focus();
      }
    });
  }
}

function harness(): { target: FrameTarget; page: never; cdp: string[] } {
  const cdp: string[] = [];
  const target = {
    frame: null,
    frameSelector: null,
    evaluate: async (expr: string) => new Function(`return ${expr}`)(),
    locator: (selector: string) => {
      const loc = {
        first: () => loc,
        click: async (): Promise<void> => {},
        fill: vi.fn(),
        type: vi.fn(),
        selector,
      };
      return loc;
    },
  } as unknown as FrameTarget;
  const page = {
    sendCDP: async (method: string, args: { type: string; key: string; text?: string }) => {
      cdp.push(`${method}:${args.type}:${args.key}`);
      if (args.type !== "keyDown") return;
      doc().activeElement?.dispatchEvent(new KeyboardEventCtor("keydown", { key: args.key }));
    },
  } as never;
  return { target, page, cdp };
}

const logger = { info: vi.fn(), warn: vi.fn() } as never;

describe("segmented date widget end-to-end", () => {
  const html =
    section("w1", "Work Experience 1", "From", [12, 9999]) +
    section("w2", "Work Experience 1", "To", [12, 9999]) +
    section("e1", "Education 1", "From", [9999]) +
    section("e2", "Education 1", "To", [9999]);

  it.each([
    ["'From' date in Work Experience 1, '012020'", 0, ["1", "2020"]],
    ["'To' date in Work Experience 1, '122021'", 1, ["12", "2021"]],
    ["'From' date of Education 1, '2016'", 2, ["2016"]],
    ["'To' date of Education 1, '2020'", 3, ["2020"]],
    ["type '012020' with a Work Experience 1 'From' hint", 0, ["1", "2020"]],
  ])("%s commits only its own group", async (step, group, expected) => {
    doc().body.innerHTML = html;
    wireWidget();
    const { target, page, cdp } = harness();
    const id = await trySegmentedDateSpinbuttonPrimitive({
      page,
      target,
      logger,
      instruction: step,
    });
    expect(id).toBe(`segmented-date-${group}`);
    expect(cdp.every((c) => c.startsWith("Input.dispatchKeyEvent"))).toBe(true);
    const groups = doc().querySelectorAll("[role='group']");
    const read = Array.from(groups).map((g) =>
      Array.from(g.querySelectorAll("input")).map((i) => i.getAttribute("aria-valuenow"))
    );
    expect(read[group]).toEqual(expected);
    read.forEach((r, i) => {
      if (i !== group) expect(r.every((v) => v === null)).toBe(true);
    });
  });
});

describe("segmented date widget sharing a fieldset", () => {
  it("commits the To year only", async () => {
    const year = (label: string): string =>
      `<div><label>${label}</label><input role="spinbutton" aria-valuemax="9999" data-max="9999" /></div>`;
    doc().body.innerHTML = `<fieldset><legend>Education 1</legend>${year("From")}${year("To")}</fieldset>`;
    wireWidget();
    const { target, page } = harness();
    const info = vi.fn();
    const id = await trySegmentedDateSpinbuttonPrimitive({
      page,
      target,
      logger: { info, warn: vi.fn() } as never,
      instruction: "'To' date of Education 1, '2020'",
    });
    expect(id).toBeTruthy();
    const vals = Array.from(doc().querySelectorAll("input")).map((i) =>
      i.getAttribute("aria-valuenow")
    );
    expect(vals).toEqual([null, "2020"]);
    // Dates can be personal data (birth dates): only their shape is logged.
    expect(info).toHaveBeenCalledWith("segmented date primitive: committed segments [9999]");
    expect(info.mock.calls.flat().join("\n")).not.toContain("2020");
  });
});

describe("executeStepWithHealing credits the segmented-date primitive", () => {
  it("returns completed without reaching act", async () => {
    doc().body.innerHTML = section("w1", "Work Experience 1", "From", [12, 9999]);
    wireWidget();
    const { target, page } = harness();
    const act = vi.fn();
    const result = await executeStepWithHealing({
      stagehand: { act } as never,
      page: page as never,
      frameTarget: target,
      step: "'From' date in Work Experience 1, '012020'",
      optional: false,
      upload: false,
      submitStep: false,
      stepIndex: 0,
      totalSteps: () => 1,
      isFinalStep: false,
      logger,
    } as never);
    expect(result).toBe("completed");
    expect(act).not.toHaveBeenCalled();
  });
});
