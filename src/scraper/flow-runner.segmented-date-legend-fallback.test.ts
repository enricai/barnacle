// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import {
  resolveSegmentedDateGroup,
  SEGMENTED_DATE_ENUMERATE_EXPR,
  type SegmentedDateGroup,
} from "@/scraper/flow-runner";

function enumerate(html: string): SegmentedDateGroup[] {
  const doc = (globalThis as unknown as { document: { body: { innerHTML: string } } }).document;
  doc.body.innerHTML = html;
  return (
    new Function(`return ${SEGMENTED_DATE_ENUMERATE_EXPR}`)() as { groups: SegmentedDateGroup[] }
  ).groups;
}

const spin = (part: string, max: number, extra = ""): string =>
  `<input role="spinbutton" aria-label="${part}" aria-valuemax="${max}" ${extra} />`;

function widget(opts: {
  question: string;
  labelledby?: string;
  captions?: boolean;
  spinExtra?: string;
}): string {
  const lb = opts.labelledby === undefined ? "" : `aria-labelledby="${opts.labelledby}"`;
  const cap = (p: string): string => (opts.captions ? `<label>${p}</label>` : "");
  return `<fieldset><legend><p><b>${opts.question}</b><abbr>*</abbr></p></legend>
    <div role="group" ${lb}><div>${cap("Month")}${spin("Month", 12, opts.spinExtra)}/${cap("Day")}${spin("Day", 31, opts.spinExtra)}/${cap("Year")}${spin("Year", 9999, opts.spinExtra)}</div></div></fieldset>`;
}

const Q = "When will you be available to start?";

describe("segmented date legend fallback", () => {
  it("names a date group by the sole-owner legend when aria-labelledby ids dangle", () => {
    const groups = enumerate(widget({ question: Q, labelledby: "missing-a ERROR" }));
    expect(groups[0]?.label?.trim()).toContain(Q);
    expect(resolveSegmentedDateGroup(`Type '12/02/2026' into '${Q}'`, groups)).toBe(0);
    expect(
      resolveSegmentedDateGroup(`In the '${Q}' date field, type the date '12/02/2026'`, groups)
    ).toBe(0);
  });

  it("resolves with a single dangling id and with no naming attribute", () => {
    for (const labelledby of ["missing-a", undefined]) {
      const groups = enumerate(widget({ question: Q, labelledby }));
      expect(resolveSegmentedDateGroup(`Type '12/02/2026' into '${Q}'`, groups)).toBe(0);
    }
  });

  it("never yields a blank outer label", () => {
    for (const g of enumerate(widget({ question: Q, labelledby: "x ERROR" }))) {
      if (!g.nested) expect(g.label?.trim()).not.toBe("");
    }
  });

  it("is not shadowed by part-word captions or part-word segment names", () => {
    const groups = enumerate(widget({ question: Q, labelledby: "x", captions: true }));
    expect(groups[0]?.label).toContain(Q);
    expect(resolveSegmentedDateGroup(`Type '12/02/2026' into '${Q}'`, groups)).toBe(0);
  });

  it("labels no group from a fieldset shared by two dates", () => {
    const groups = enumerate(
      `<fieldset><legend>Dates of employment</legend>
        <div><div role="group" aria-labelledby="gone">${spin("Month", 12)}${spin("Day", 31)}${spin("Year", 9999)}</div></div>
        <div role="group" aria-labelledby="gone2">${spin("Month", 12)}${spin("Day", 31)}${spin("Year", 9999)}</div>
      </fieldset>`
    );
    for (const g of groups) expect(g.label ?? "").not.toContain("Dates of employment");
  });

  it("lets a legend-less inner fieldset inherit the sole-owner outer fieldset legend", () => {
    const groups = enumerate(
      `<fieldset><legend>${Q}</legend><fieldset><div>${spin("Month", 12)}${spin("Day", 31)}${spin("Year", 9999)}</div></fieldset></fieldset>`
    );
    expect(resolveSegmentedDateGroup(`Type '12/02/2026' into '${Q}'`, groups)).toBe(0);
  });
});
