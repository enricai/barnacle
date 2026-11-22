// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import {
  resolveSegmentedDateGroup,
  runSegmentedDateSpinbuttonPrimitive,
  SEGMENTED_DATE_ENUMERATE_EXPR,
  type SegmentedDateGroup,
} from "@/scraper/flow-runner";

type El = {
  value: string;
  getAttribute: (n: string) => string | null;
  setAttribute: (n: string, v: string) => void;
};
type Doc = {
  body: { innerHTML: string };
  activeElement: El | null;
  querySelector: (s: string) => El | null;
};
type Primitive = Parameters<typeof runSegmentedDateSpinbuttonPrimitive>[0];

const doc = (): Doc => (globalThis as unknown as { document: Doc }).document;
const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
} as unknown as Primitive["logger"];

interface Shape {
  /** Field label points at its first segment, as a native label does. */
  labelFor: boolean;
  /** Every segment also names the field through aria-labelledby. */
  segmentLabelledby: boolean;
}

const segment = (id: string, part: "m" | "y", shape: Shape): string => {
  const attrs = [
    `id="${id}-${part}"`,
    'role="spinbutton"',
    `aria-valuemax="${part === "m" ? 12 : 9999}"`,
    `aria-label="${part === "m" ? "Month" : "Year"}"`,
    shape.segmentLabelledby ? `aria-labelledby="${id}-label"` : "",
  ];
  return `<div><div>${part === "m" ? "MM" : "YYYY"}</div><input ${attrs.join(" ")} /></div>`;
};
const field = (id: string, label: string, parts: ("m" | "y")[], shape: Shape): string =>
  `<div><label id="${id}-label"${shape.labelFor ? ` for="${id}-${parts[0]}"` : ""}>${label}</label><div>${parts
    .map((part) => segment(id, part, shape))
    .join("")}</div></div>`;
const section = (title: string, body: string): string =>
  `<div role="group" aria-labelledby="${title.replace(/\W/g, "")}"><h3 id="${title.replace(/\W/g, "")}">${title}</h3>${body}</div>`;
const page = (shape: Shape): string =>
  section(
    "Work Experience 1",
    field("ws", "From", ["m", "y"], shape) + field("we", "To", ["m", "y"], shape)
  ) +
  section(
    "Education 1",
    field("es", "From", ["y"], shape) + field("ee", "To (actual or expected)", ["y"], shape)
  );

async function run(
  html: string,
  instruction: string
): Promise<{ kind: string; calls: string[]; value: (id: string) => string }> {
  doc().body.innerHTML = html;
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
      fill: vi.fn(),
    }),
  } as unknown as Primitive["target"];
  const cdp = {
    sendCDP: async (m: string, a: { type?: string; text?: string }): Promise<void> => {
      calls.push(m);
      const el = doc().activeElement;
      if (m !== "Input.dispatchKeyEvent" || a.type !== "keyDown") return;
      if (el?.getAttribute("role") !== "spinbutton") return;
      el.value = `${el.value}${a.text}`;
      el.setAttribute("aria-valuenow", String(Number(el.value)));
    },
  } as unknown as Primitive["page"];
  const out = await runSegmentedDateSpinbuttonPrimitive({
    page: cdp,
    target,
    instruction,
    logger,
  });
  return {
    kind: out.kind,
    calls,
    value: (id) => doc().querySelector(`#${id}`)?.value ?? "",
  };
}

const SHAPES: [string, Shape][] = [
  ["plain captions", { labelFor: false, segmentLabelledby: false }],
  ["label for the first segment", { labelFor: true, segmentLabelledby: false }],
  ["segments labelled by the field caption", { labelFor: false, segmentLabelledby: true }],
  [
    "label for the first segment and segments labelled by it",
    { labelFor: true, segmentLabelledby: true },
  ],
];

describe("segmented date fields whose segments each sit in their own display wrapper", () => {
  it.each(SHAPES)("%s: each step lands in the group it names only", async (_n, shape) => {
    const cases: [string, Record<string, string>][] = [
      ["'From' date in Work Experience 1, '012020'", { "ws-m": "01", "ws-y": "2020" }],
      ["'To' date in Work Experience 1, '112019'", { "we-m": "11", "we-y": "2019" }],
      ["'From' date of Education 1, '2016'", { "es-y": "2016" }],
      ["'To' date of Education 1, '2020'", { "ee-y": "2020" }],
    ];
    const ids = ["ws-m", "ws-y", "we-m", "we-y", "es-y", "ee-y"];
    for (const [step, expected] of cases) {
      const r = await run(page(shape), step);
      expect(r.kind).toBe("committed");
      expect(r.calls).not.toContain("Input.insertText");
      for (const id of ids) expect(r.value(id)).toBe(expected[id] ?? "");
    }
  });

  it("does not type a lone year into a month/year group whose caption names the pair", async () => {
    const r = await run(
      page({ labelFor: true, segmentLabelledby: false }),
      "'From' date in Work Experience 1, '2016'"
    );
    expect(r.value("ws-y")).toBe("");
    expect(r.value("ws-m")).toBe("");
  });
});

const enumerate = (html: string): SegmentedDateGroup[] => {
  doc().body.innerHTML = html;
  return (
    new Function(`return ${SEGMENTED_DATE_ENUMERATE_EXPR}`)() as {
      groups: SegmentedDateGroup[];
    }
  ).groups;
};

describe("a fieldset legend names a date group only when the group is its sole content", () => {
  const Q = "When will you be available to start work?";
  const seg = (max: number, attrs = ""): string =>
    `<input role="spinbutton" aria-valuemax="${max}" ${attrs} />`;
  const STEPS = [
    `Type '12/02/2026' into '${Q}'`,
    `In the '${Q}' date field, type the date '12/02/2026' (month 12, day 02, year 2026)`,
  ];

  it("labels a lone date by its legend when aria-labelledby names missing ids", () => {
    const missing = 'aria-labelledby="gone-1 gone-2"';
    const groups = enumerate(
      `<fieldset><legend>${Q}</legend><div>${seg(12, missing)}${seg(31, missing)}${seg(9999, missing)}</div></fieldset>`
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]?.label).toBe(Q);
    for (const step of STEPS) expect(resolveSegmentedDateGroup(step, groups)).toBe(0);
  });

  it("does not label either date group by a legend shared between them", () => {
    const groups = enumerate(
      `<fieldset><legend>${Q}</legend><div><div role="group">${seg(12)}${seg(9999)}</div></div><div><div role="group">${seg(12)}${seg(9999)}</div></div></fieldset>`
    );
    expect(groups).toHaveLength(2);
    for (const g of groups) expect(g.label).not.toContain(Q);
    for (const step of STEPS) expect(resolveSegmentedDateGroup(step, groups)).toBeNull();
  });

  it("treats a whitespace-only name as no name", () => {
    const groups = enumerate(
      `<fieldset><legend>${Q}</legend><div aria-label="   ">${seg(12)}${seg(9999)}</div></fieldset>`
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]?.label).toBe(Q);
  });
});
