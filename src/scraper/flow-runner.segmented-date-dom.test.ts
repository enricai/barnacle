// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import {
  resolveSegmentedDateGroup,
  SEGMENTED_DATE_ENUMERATE_EXPR,
  type SegmentedDateGroup,
} from "@/scraper/flow-runner";

function section(headingId: string, title: string, label: string, maxes: number[]): string {
  const spins = maxes.map((m) => `<input role="spinbutton" aria-valuemax="${m}" />`).join("");
  return `<section aria-labelledby="${headingId}"><h3 id="${headingId}">${title}</h3><div role="group" aria-label="${label}">${spins}</div></section>`;
}

function enumerate(html: string): SegmentedDateGroup[] {
  const doc = (globalThis as unknown as { document: { body: { innerHTML: string } } }).document;
  doc.body.innerHTML = html;
  const out = new Function(`return ${SEGMENTED_DATE_ENUMERATE_EXPR}`)() as {
    groups: SegmentedDateGroup[];
  };
  return out.groups;
}

describe("segmented date DOM enumeration", () => {
  const html =
    section("w1", "Work Experience 1", "From", [12, 9999]) +
    section("w2", "Work Experience 1", "To", [12, 9999]) +
    section("e1", "Education 1", "From", [9999]) +
    section("e2", "Education 1", "To", [9999]);

  it("resolves each step to the expected group", () => {
    const groups = enumerate(html);
    expect(groups).toHaveLength(4);
    expect(resolveSegmentedDateGroup("'From' date in Work Experience 1, '012020'", groups)).toBe(0);
    expect(resolveSegmentedDateGroup("'To' date in Work Experience 1, '012021'", groups)).toBe(1);
    expect(resolveSegmentedDateGroup("'From' date of Education 1, '2016'", groups)).toBe(2);
    expect(resolveSegmentedDateGroup("'To' date of Education 1, '2020'", groups)).toBe(3);
  });

  it("returns null on an ambiguous tie", () => {
    const groups = enumerate(
      section("a", "Work Experience 1", "From", [12, 9999]) +
        section("b", "Work Experience 1", "From", [12, 9999])
    );
    expect(
      resolveSegmentedDateGroup("'From' date in Work Experience 1, '012020'", groups)
    ).toBeNull();
  });

  it("infers segment widths when aria-valuemax is absent", () => {
    const groups = enumerate(
      `<div role="group" aria-label="Start"><input role="spinbutton" aria-label="month" /><input role="spinbutton" aria-label="year" /></div>`
    );
    expect(groups[0]?.segmentMaxes).toEqual([12, 9999]);
    expect(resolveSegmentedDateGroup("type '012020' into the date", groups)).toBe(0);
  });

  it("targets a lone month/year group whose label shares no words with the step", () => {
    const groups = enumerate(section("s", "Dates", "Employment period", [12, 9999]));
    expect(resolveSegmentedDateGroup("type '03/2018' into the Start field", groups)).toBe(0);
  });

  it("disambiguates same-width groups by the heading above their section", () => {
    const row = (title: string, label: string): string =>
      `<div><h3>${title}</h3><div><label>${label}</label><div><input role="spinbutton" aria-valuemax="12" /><input role="spinbutton" aria-valuemax="9999" /></div></div></div>`;
    const groups = enumerate(row("Work Experience 1", "From") + row("Education 1", "From"));
    expect(resolveSegmentedDateGroup("'From' date of Education 1, '092016'", groups)).toBe(1);
    expect(resolveSegmentedDateGroup("'From' date in Work Experience 1, '012020'", groups)).toBe(0);
  });

  it("splits From/To year spinbuttons that share one fieldset", () => {
    const year = (label: string): string =>
      `<div><label>${label}</label><input role="spinbutton" aria-valuemax="9999" /></div>`;
    const groups = enumerate(
      `<fieldset><legend>Education 1</legend>${year("From")}${year("To")}</fieldset>`
    );
    expect(resolveSegmentedDateGroup("'From' date of Education 1, '2016'", groups)).toBe(1);
    expect(resolveSegmentedDateGroup("'To' date of Education 1, '2020'", groups)).toBe(2);
  });

  it("never picks a lone nested segment on width alone", () => {
    const groups = enumerate(
      `<div role="group" aria-label="Period"><div><input role="spinbutton" aria-valuemax="12" /></div><div><input role="spinbutton" aria-valuemax="9999" /></div></div>`
    );
    expect(resolveSegmentedDateGroup("type '2016' into the form", groups)).toBeNull();
    expect(resolveSegmentedDateGroup("type '012016' into the form", groups)).toBe(0);
  });
});
