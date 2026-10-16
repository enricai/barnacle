// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import {
  resolveSegmentedDateGroup,
  SEGMENTED_DATE_ENUMERATE_EXPR,
  type SegmentedDateGroup,
  trySegmentedDateSpinbuttonPrimitive,
  verifyFillReadback,
} from "@/scraper/flow-runner";

type Primitive = Parameters<typeof trySegmentedDateSpinbuttonPrimitive>[0];
type El = {
  id: string;
  value: string;
  getAttribute: (n: string) => string | null;
  setAttribute: (n: string, v: string) => void;
};
type Doc = {
  body: { innerHTML: string };
  activeElement: El | null;
  getElementById: (id: string) => El | null;
};

const doc = (): Doc => (globalThis as unknown as { document: Doc }).document;

const seg = (id: string, max: number, label: string): string =>
  `<div><input id="${id}" role="spinbutton" aria-label="${label}" aria-valuemax="${max}" /></div>`;
const monthYear = (p: string): string => seg(`${p}-m`, 12, "Month") + seg(`${p}-y`, 9999, "Year");
const section = (title: string, label: string, segs: string): string =>
  `<section><h3>${title}</h3><div role="group" aria-label="${label}">${segs}</div></section>`;

const PAGE =
  section("Work Experience 1", "From", monthYear("wf")) +
  section("Work Experience 1", "To", monthYear("wt")) +
  section("Education 1", "From", seg("ef-y", 9999, "Year")) +
  section("Education 1", "To", seg("et-y", 9999, "Year"));

function install(html: string): void {
  doc().body.innerHTML = html;
  const g = globalThis as unknown as Record<string, unknown>;
  g.XPathResult = { FIRST_ORDERED_NODE_TYPE: 9 };
}

function enumerate(): SegmentedDateGroup[] {
  const out = new Function(`return ${SEGMENTED_DATE_ENUMERATE_EXPR}`)() as {
    groups: SegmentedDateGroup[];
  };
  return out.groups;
}

async function type(instruction: string): Promise<string | null> {
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
      if (m !== "Input.dispatchKeyEvent" || a.type !== "keyDown") return;
      const el = doc().activeElement;
      if (el?.getAttribute("role") !== "spinbutton") return;
      el.value = `${el.value}${a.text}`;
      el.setAttribute("aria-valuenow", String(Number(el.value)));
    },
  } as unknown as Primitive["page"];
  const logger = { info: vi.fn(), warn: vi.fn() } as unknown as Primitive["logger"];
  return trySegmentedDateSpinbuttonPrimitive({ page, target, instruction, logger });
}

const values = (): Record<string, string> =>
  Object.fromEntries(
    ["wf-m", "wf-y", "wt-m", "wt-y", "ef-y", "et-y"].map((id) => [
      id,
      doc().getElementById(id)?.value ?? "",
    ])
  );

async function readback(id: string): Promise<string | undefined> {
  (doc() as unknown as Record<string, unknown>).evaluate = (): { singleNodeValue: unknown } => ({
    singleNodeValue: doc().getElementById(id),
  });
  const target = {
    evaluate: async (expr: string): Promise<unknown> => new Function(`return ${expr}`)(),
  };
  return (await verifyFillReadback(target as never, `//*[@id='${id}']`, "01"))?.outcome;
}

describe("segmented date acceptance (neutral markup, report steps)", () => {
  it("resolves every step to its group", () => {
    install(PAGE);
    const groups = enumerate();
    expect(groups.filter((g) => !g.nested)).toHaveLength(4);
    expect(resolveSegmentedDateGroup("'From' date in Work Experience 1, '012020'", groups)).toBe(0);
    expect(resolveSegmentedDateGroup("'From' date of Education 1, '2016'", groups)).toBe(2);
    expect(resolveSegmentedDateGroup("'To' date of Education 1, '2020'", groups)).toBe(3);
  });

  it.each([
    ["'From' date in Work Experience 1, '012020'", { "wf-m": "01", "wf-y": "2020" }],
    ["'From' date of Education 1, '2016'", { "ef-y": "2016" }],
    ["'To' date of Education 1, '2020'", { "et-y": "2020" }],
    ["Enter '122024' for 'To' in Work Experience 1", { "wt-m": "12", "wt-y": "2024" }],
  ])("delivers %s to the owning segments only", async (step, expected) => {
    install(PAGE);
    expect(await type(step)).not.toBeNull();
    const filled = Object.fromEntries(Object.entries(values()).filter(([, v]) => v !== ""));
    expect(filled).toEqual(expected);
  });

  it("types per-segment and lone whole-date steps into a lone widget", async () => {
    const lone = section("Dates", "Period", monthYear("wf"));
    install(lone);
    expect(await type("type '01' into Month")).not.toBeNull();
    expect(await type("type '2020' into Year")).not.toBeNull();
    expect(values()).toMatchObject({ "wf-m": "01", "wf-y": "2020" });
    install(lone);
    expect(await type("type '012020'")).not.toBeNull();
    expect(values()).toMatchObject({ "wf-m": "01", "wf-y": "2020" });
  });

  it("reports segment readback for every segment of a multi-segment widget", async () => {
    install(PAGE);
    for (const id of ["wf-m", "wf-y", "wt-m", "wt-y"]) {
      expect(await readback(id)).toBe("segment");
    }
  });
});
