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
  document.body.innerHTML = html;
  const out = (0, eval)(SEGMENTED_DATE_ENUMERATE_EXPR) as { groups: SegmentedDateGroup[] };
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
});
