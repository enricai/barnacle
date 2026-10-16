// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import {
  resolveSegmentedDateGroup,
  SEGMENTED_DATE_ENUMERATE_EXPR,
  type SegmentedDateGroup,
} from "@/scraper/flow-runner";

function group(label: string, extra = ""): string {
  return `<div role="group" aria-label="${label}" ${extra}><input role="spinbutton" aria-valuemax="12" /><input role="spinbutton" aria-valuemax="9999" /></div>`;
}

function enumerate(html: string): SegmentedDateGroup[] {
  const doc = (globalThis as unknown as { document: { body: { innerHTML: string } } }).document;
  doc.body.innerHTML = html;
  return (
    new Function(`return ${SEGMENTED_DATE_ENUMERATE_EXPR}`)() as { groups: SegmentedDateGroup[] }
  ).groups;
}

const TO_STEP =
  "Click the 'MM' month part of the 'To' date in Work Experience 1 and type '122024' in one go — the date field auto-advances from month to year";

describe("segmented date own-label selection", () => {
  it("returns null when only a From group is rendered", () => {
    expect(resolveSegmentedDateGroup(TO_STEP, enumerate(group("From")))).toBeNull();
  });

  it("picks To when both groups are rendered", () => {
    expect(resolveSegmentedDateGroup(TO_STEP, enumerate(group("From") + group("To")))).toBe(1);
  });

  it("matches whole words only", () => {
    expect(resolveSegmentedDateGroup(TO_STEP, enumerate(group("Total")))).toBeNull();
  });

  it("resolves the From group for a Year spinbutton step", () => {
    const step = "Click the Year spinbutton in the 'From' date of Education 1 and type '2015'";
    const groups = enumerate(
      `<div role="group" aria-label="From"><input role="spinbutton" aria-valuemax="9999" /></div>`
    );
    expect(resolveSegmentedDateGroup(step, groups)).toBe(0);
  });

  it("never returns a group with no visible segment", () => {
    const groups = enumerate(group("To", 'style="display:none"') + group("From"));
    expect(groups).toHaveLength(1);
    expect(resolveSegmentedDateGroup(TO_STEP, groups)).toBeNull();
  });

  it("keeps the existing ranking when no labels are quoted", () => {
    expect(
      resolveSegmentedDateGroup("type '012020' into the date", enumerate(group("Start")))
    ).toBe(0);
  });

  const UNQUOTED_TO_STEP =
    "Click the MM month part of the To date in Work Experience 1 and type '122024' in one go — the date field auto-advances from month to year";

  function section(heading: string, label: string): string {
    return `<section><h3>${heading}</h3>${group(label)}</section>`;
  }

  it("does not let the prose word 'from' select the From group for an unquoted To step", () => {
    expect(
      resolveSegmentedDateGroup(UNQUOTED_TO_STEP, enumerate(section("Work Experience 1", "From")))
    ).toBeNull();
  });

  it("picks the To group for an unquoted To step when both are rendered", () => {
    const html = section("Work Experience 1", "From") + section("Work Experience 1", "To");
    expect(resolveSegmentedDateGroup(UNQUOTED_TO_STEP, enumerate(html))).toBe(1);
  });

  it("does not write a To value into a group labelled only Start date", () => {
    expect(
      resolveSegmentedDateGroup(
        UNQUOTED_TO_STEP,
        enumerate(section("Work Experience 1", "Start date"))
      )
    ).toBeNull();
  });

  it("does not take another section's To when the named section renders no To", () => {
    const html =
      section("Work Experience 1", "From") +
      section("Education 1", "From") +
      section("Education 1", "To");
    expect(resolveSegmentedDateGroup(TO_STEP, enumerate(html))).toBeNull();
  });

  it("still resolves the named section's To among several sections", () => {
    const html =
      section("Education 1", "From") +
      section("Education 1", "To") +
      section("Work Experience 1", "From") +
      section("Work Experience 1", "To");
    expect(resolveSegmentedDateGroup(TO_STEP, enumerate(html))).toBe(3);
  });
});
