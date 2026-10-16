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

const seg = (label: string, max: number): string =>
  `<div><label for="${label}">${label}</label><input id="${label}" role="spinbutton" aria-valuemax="${max}" /></div>`;
const field = (label: string, segs: string): string =>
  `<div><label>${label}</label><div>${segs}</div></div>`;
const section = (heading: string, fields: string): string =>
  `<section><h3>${heading}</h3>${fields}</section>`;

function page(from: string, to: string): string {
  return (
    section(
      "Employment 1",
      field(from, `${seg("MM", 12)}${seg("YYYY", 9999)}`) +
        field(to, `${seg("MM", 12)}${seg("YYYY", 9999)}`)
    ) + section("Course 1", field(from, seg("YYYY", 9999)) + field(to, seg("YYYY", 9999)))
  );
}

describe("segmented date wrapper-per-segment grouping", () => {
  it("groups each date field into one group", () => {
    const groups = enumerate(page("From", "To")).filter((g) => !g.nested);
    expect(groups.map((g) => g.segmentMaxes)).toEqual([[12, 9999], [12, 9999], [9999], [9999]]);
    expect(groups.map((g) => g.label)).toEqual(["From", "To", "From", "To"]);
  });

  it("resolves whole-date and year steps", () => {
    const groups = enumerate(page("From", "To"));
    const pick = (step: string): SegmentedDateGroup | undefined => {
      const i = resolveSegmentedDateGroup(step, groups);
      return i === null ? undefined : groups[i];
    };
    expect(pick("'From' date in Employment 1, '012020'")?.segmentMaxes).toEqual([12, 9999]);
    expect(pick("'From' date of Course 1, '2016'")?.segmentMaxes).toEqual([9999]);
    expect(pick("'To' date of Course 1, '2020'")?.segmentMaxes).toEqual([9999]);
  });

  it("resolves by the group's own label when labels differ", () => {
    const groups = enumerate(page("Start", "Finish"));
    const i = resolveSegmentedDateGroup("'Finish' date in Employment 1, '122024'", groups);
    expect(i === null ? null : groups[i]?.label).toBe("Finish");
  });
  it("groups own-wrapper and shared-wrapper segment markup identically", () => {
    const bare = (label: string, max: number): string =>
      `<input aria-label="${label}" role="spinbutton" aria-valuemax="${max}" />`;
    const own = field("From", seg("MM", 12) + seg("YYYY", 9999));
    const shared = field("From", bare("MM", 12) + bare("YYYY", 9999));
    for (const html of [own, shared]) {
      const groups = enumerate(html).filter((g) => !g.nested);
      expect(groups.map((g) => g.segmentMaxes)).toEqual([[12, 9999]]);
      expect(groups.map((g) => g.label)).toEqual(["From"]);
    }
  });
});
