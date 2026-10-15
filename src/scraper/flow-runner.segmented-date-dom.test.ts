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
    expect(resolveSegmentedDateGroup("'Start' date, '012020'", groups)).toBe(0);
  });

  it("returns null for a lone group whose own label does not match the target field", () => {
    const groups = enumerate(section("s", "Dates", "Employment period", [12, 9999]));
    expect(resolveSegmentedDateGroup("type '03/2018' into the Start field", groups)).toBeNull();
    expect(resolveSegmentedDateGroup("'Start' date, '03/2018'", groups)).toBeNull();
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
    expect(resolveSegmentedDateGroup("'Period' date, '012016'", groups)).toBe(0);
  });
});

describe("segmented date own label and visibility", () => {
  const pair = (hiddenAttrs: string): string =>
    `<section aria-labelledby="t"><h3 id="t">Flight Search</h3>` +
    `<div role="group" aria-label="Departure"><input role="spinbutton" aria-valuemax="12" /><input role="spinbutton" aria-valuemax="9999" /></div>` +
    `<div ${hiddenAttrs}><div role="group" aria-label="Return"><input role="spinbutton" aria-valuemax="12" /><input role="spinbutton" aria-valuemax="9999" /></div></div></section>`;

  it.each(['style="display:none"', "hidden", 'aria-hidden="true"'])(
    "skips groups under a hidden ancestor (%s)",
    (attrs) => {
      const groups = enumerate(pair(attrs));
      expect(groups.map((g) => g.label)).toEqual(["Departure"]);
    }
  );

  it("keeps own label separate from section context", () => {
    const groups = enumerate(pair(""));
    expect(groups.map((g) => g.label)).toEqual(["Departure", "Return"]);
    expect(groups[1]?.section).toBe("Flight Search");
    expect(groups[1]?.label).not.toContain("Flight");
  });
});

describe("segmented date hidden group beside visible group", () => {
  const spins = `<input role="spinbutton" aria-valuemax="12" /><input role="spinbutton" aria-valuemax="9999" />`;
  const work = (toAttrs: string): string =>
    `<section aria-labelledby="w"><h3 id="w">Work Experience 1</h3>` +
    `<div role="group" aria-label="From">${spins}</div>` +
    `<div ${toAttrs}><div role="group" aria-label="To">${spins}</div></div></section>`;
  const edu = (label: string): string =>
    `<section aria-labelledby="e${label}"><h3 id="e${label}">Education 1</h3><div role="group" aria-label="${label}"><input role="spinbutton" aria-valuemax="9999" /></div></section>`;

  it.each(['style="display:none"', "hidden"])(
    "never resolves a hidden 'To' group to the visible 'From' group (%s)",
    (attrs) => {
      const groups = enumerate(work(attrs) + edu("From") + edu("To"));
      expect(groups.map((g) => g.label)).toEqual(["From", "From", "To"]);
      expect(
        resolveSegmentedDateGroup("'To' date in Work Experience 1, '012021'", groups)
      ).toBeNull();
      expect(resolveSegmentedDateGroup("'From' date in Work Experience 1, '012020'", groups)).toBe(
        0
      );
      expect(resolveSegmentedDateGroup("'From' date of Education 1, '2016'", groups)).toBe(1);
      expect(resolveSegmentedDateGroup("'To' date of Education 1, '2020'", groups)).toBe(2);
    }
  );
});

describe("segmented date unquoted and lone targets", () => {
  const spins = `<input role="spinbutton" aria-valuemax="12" /><input role="spinbutton" aria-valuemax="9999" />`;
  const group = (title: string, label: string, helper = ""): string =>
    `<section><h3>${title}</h3>${helper}<div role="group" aria-label="${label}">${spins}</div></section>`;

  it("resolves unquoted field wording by the group's own label", () => {
    const groups = enumerate(group("Work Experience 1", "From") + group("Work Experience 1", "To"));
    expect(
      resolveSegmentedDateGroup("type '012020' into the Work Experience 1 From date", groups)
    ).toBe(0);
    expect(resolveSegmentedDateGroup("Enter 122024 as the Work Experience 1 To date", groups)).toBe(
      1
    );
  });

  it("fills the only group when the step names no field", () => {
    const groups = enumerate(group("Dates", "Period"));
    expect(resolveSegmentedDateGroup("type '012020'", groups)).toBe(0);
  });

  it("never lands a To value in the visible From group when To is not rendered", () => {
    const groups = enumerate(
      group("Work Experience 1", "From") + `<div hidden>${group("Work Experience 1", "To")}</div>`
    );
    expect(
      resolveSegmentedDateGroup("'To' date in Work Experience 1, '122024'", groups)
    ).toBeNull();
    expect(
      resolveSegmentedDateGroup("type '122024' into the Work Experience 1 To date", groups)
    ).toBeNull();
  });

  it("ignores prose helper text mentioning from or to", () => {
    const helper = "<p>Enter dates from your first day to your last day</p>";
    const groups = enumerate(group("Work Experience 1", "From", helper));
    expect(
      resolveSegmentedDateGroup("'To' date in Work Experience 1, '122024'", groups)
    ).toBeNull();
  });
});
