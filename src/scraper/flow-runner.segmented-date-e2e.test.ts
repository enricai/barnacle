// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import {
  resolveSegmentedDateGroup,
  trySegmentedDateSpinbuttonPrimitive,
} from "@/scraper/flow-runner";

type Primitive = Parameters<typeof trySegmentedDateSpinbuttonPrimitive>[0];
type Doc = {
  body: { innerHTML: string };
  activeElement: {
    value: string;
    getAttribute: (n: string) => string | null;
    setAttribute: (n: string, v: string) => void;
  } | null;
  querySelectorAll: (sel: string) => Iterable<{ scrollIntoView?: undefined }>;
};

const spins = (m: number[]): string =>
  m.map((x) => `<input role="spinbutton" aria-valuemax="${x}" />`).join("");

async function run(
  html: string,
  instruction: string,
  noScroll = false
): Promise<{ id: string | null; calls: string[] }> {
  const doc = (globalThis as unknown as { document: Doc }).document;
  doc.body.innerHTML = html;
  if (noScroll) {
    for (const e of doc.querySelectorAll("input")) e.scrollIntoView = undefined;
  }
  const calls: string[] = [];
  const target = {
    frame: null,
    evaluate: async (expr: string): Promise<unknown> => new Function(`return ${expr}`)(),
    locator: () => ({
      first() {
        return this;
      },
      click: async (): Promise<void> => {},
      type: vi.fn(),
    }),
  } as unknown as Primitive["target"];
  const page = {
    sendCDP: async (m: string, a: { type: string; text?: string }): Promise<void> => {
      calls.push(`${m}:${a.type}:${a.text ?? ""}`);
      if (m !== "Input.dispatchKeyEvent" || a.type !== "keyDown") return;
      const el = doc.activeElement;
      if (el?.getAttribute("role") !== "spinbutton") return;
      el.value = `${el.value}${a.text}`;
      el.setAttribute("aria-valuenow", String(Number(el.value)));
    },
  } as unknown as Primitive["page"];
  const logger = { info: vi.fn(), warn: vi.fn() } as unknown as Primitive["logger"];
  const id = await trySegmentedDateSpinbuttonPrimitive({ page, target, instruction, logger });
  return { id, calls };
}
const html =
  `<section><h3>Work Experience 1</h3><div role="group" aria-label="From">${spins([12, 9999])}</div><div role="group" aria-label="To">${spins([12, 9999])}</div></section>` +
  `<section><h3>Education 1</h3><div role="group" aria-label="From">${spins([9999])}</div><div role="group" aria-label="To">${spins([9999])}</div></section>`;
describe("segmented date primitive against a real DOM", () => {
  it("work from", async () => {
    const r = await run(html, "'From' date in Work Experience 1, '012020'");
    expect(r.id).toBe("segmented-date-0");
  });
  it("edu to", async () => {
    const r = await run(html, "'To' date of Education 1, '2020'");
    expect(r.id).toBe("segmented-date-3");
  });
  it("still delivers key events when the DOM has no scrollIntoView", async () => {
    const r = await run(html, "'From' date in Work Experience 1, '012020'", true);
    expect(r.id).toBe("segmented-date-0");
  });
  it("hidden To", async () => {
    const h = html.replace(
      `<div role="group" aria-label="To">${spins([12, 9999])}`,
      `<div hidden role="group" aria-label="To">${spins([12, 9999])}`
    );
    const r = await run(h, "'To' date in Work Experience 1, '012021'");
    expect(r.id).toBeNull();
    expect(r.calls).toHaveLength(0);
  });
});
const sec = (t: string, l: string, m: number[], attrs = "") =>
  `<section><h3>${t}</h3><div ${attrs}><label>${l}</label><div>${spins(m)}</div></div></section>`;
const secFs = (t: string, l: string, m: number[]) =>
  `<fieldset><legend>${t}</legend><div data-automation-id="formField-${l}"><label>${l}</label><div>${spins(m)}</div></div></fieldset>`;
const cases: [string, string, string, string | null][] = [
  [
    "label wrap",
    sec("Certifications 2", "Start", [12, 9999]) + sec("Certifications 2", "End", [12, 9999]),
    "Set the 'End' date for Certifications 2 to '052021'",
    "segmented-date-1",
  ],
  [
    "different wording",
    sec("Job 1", "From", [12, 9999]) + sec("Job 1", "To", [12, 9999]),
    "Enter '122024' for 'To' in Job 1",
    "segmented-date-1",
  ],
  [
    "vis hidden To",
    sec("Job 1", "From", [12, 9999]) + sec("Job 1", "To", [12, 9999], 'style="visibility:hidden"'),
    "'To' date in Job 1, '122024'",
    null,
  ],
  ["To absent", sec("Job 1", "From", [12, 9999]), "'To' date in Job 1, '122024'", null],
  ["lone type", sec("Dates", "Employment period", [12, 9999]), "type '012020'", "segmented-date-0"],
  [
    "lone type bare",
    sec("Dates", "Date", [12, 9999]),
    "type 012020 into the date field",
    "segmented-date-0",
  ],
  [
    "formfield",
    secFs("Work Experience 1", "From", [12, 9999]) + secFs("Work Experience 1", "To", [12, 9999]),
    "'To' date in Work Experience 1, '122024'",
    "segmented-date-1",
  ],
  [
    "separator",
    sec("Job 1", "From", [12, 9999]),
    "'From' date in Job 1, '01/2020'",
    "segmented-date-0",
  ],
  [
    "dot sep",
    sec("Job 1", "From", [12, 9999]),
    "'From' date in Job 1, '01-2020'",
    "segmented-date-0",
  ],
];
describe("segmented date primitive DOM variants", () => {
  for (const [n, h, i, exp] of cases)
    it(n, async () => {
      const r = await run(h, i);
      expect(r.id).toBe(exp);
      if (exp === null) expect(r.calls).toHaveLength(0);
    });
});
describe("context only", () => {
  const g = (context: string, m: number[]) => ({ segmentMaxes: m, context });
  it("works", () => {
    const groups = [
      g("Work Experience 1 From", [12, 9999]),
      g("Work Experience 1 To", [12, 9999]),
      g("Education 1 From", [9999]),
      g("Education 1 To", [9999]),
    ];
    expect(resolveSegmentedDateGroup("'From' date in Work Experience 1, '012020'", groups)).toBe(0);
    expect(resolveSegmentedDateGroup("'To' date in Work Experience 1, '012020'", groups)).toBe(1);
    expect(resolveSegmentedDateGroup("'To' date of Education 1, '2020'", groups)).toBe(3);
    expect(
      resolveSegmentedDateGroup(
        "'To' date of Education 1, '2020'",
        groups.filter((_, i) => i !== 3)
      )
    ).toBeNull();
    const lbl = [g("Job 3 Start Date", [12, 9999]), g("Job 3 End Date", [12, 9999])];
    expect(resolveSegmentedDateGroup("'End Date' of Job 3, '052021'", lbl)).toBe(1);
    expect(resolveSegmentedDateGroup("'Start Date' of Job 3, '052021'", lbl)).toBe(0);
    expect(resolveSegmentedDateGroup("type '012020'", [g("Dates", [12, 9999])])).toBe(0);
    expect(
      resolveSegmentedDateGroup("'To' date, '012020'", [g("Work Experience 1 From", [12, 9999])])
    ).toBeNull();
  });
});
