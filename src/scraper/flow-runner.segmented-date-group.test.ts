import { describe, expect, it } from "vitest";
import {
  parseSegmentedDateValue,
  resolveSegmentedDateGroup,
  type SegmentedDateGroup,
} from "@/scraper/flow-runner";

const GROUPS: SegmentedDateGroup[] = [
  {
    segmentMaxes: [12, 9999],
    context: "Work Experience 1 From",
    label: "From",
    section: "Work Experience 1",
  },
  {
    segmentMaxes: [12, 9999],
    context: "Work Experience 1 To",
    label: "To",
    section: "Work Experience 1",
  },
  { segmentMaxes: [9999], context: "Education 1 From", label: "From", section: "Education 1" },
  { segmentMaxes: [9999], context: "Education 1 To", label: "To", section: "Education 1" },
];

describe("flow-runner/segmented date group resolution", () => {
  it("resolves each step to its group", () => {
    expect(resolveSegmentedDateGroup("'From' date in Work Experience 1, '012020'", GROUPS)).toBe(0);
    expect(resolveSegmentedDateGroup("'From' date of Education 1, '2016'", GROUPS)).toBe(2);
    expect(resolveSegmentedDateGroup("'To' date of Education 1, '2020'", GROUPS)).toBe(3);
  });

  it("resolves the To step to the To group", () => {
    expect(resolveSegmentedDateGroup("'To' date in Work Experience 1, '012021'", GROUPS)).toBe(1);
  });

  it("returns null on a tie", () => {
    const tied = [GROUPS[2], GROUPS[2]] as SegmentedDateGroup[];
    expect(resolveSegmentedDateGroup("'From' date of Education 1, '2016'", tied)).toBeNull();
  });

  it("never returns a width-compatible group whose own label does not match", () => {
    const fromOnly = [GROUPS[2]] as SegmentedDateGroup[];
    expect(resolveSegmentedDateGroup("'To' date of Education 1, '2020'", fromOnly)).toBeNull();
  });

  it("returns null on a digit-count mismatch", () => {
    expect(
      resolveSegmentedDateGroup("'From' date in Work Experience 1, '75201'", GROUPS)
    ).toBeNull();
  });

  it("does not parse phone numbers", () => {
    expect(parseSegmentedDateValue("Fill the phone with '555-123-4567'")).toBeNull();
  });
});

describe("segmented date resolution from context alone", () => {
  const g = (context: string, maxes: number[]): SegmentedDateGroup => ({
    segmentMaxes: maxes,
    context,
  });
  const PROSE_TO_STEP =
    "Click the 'MM' month part of the 'To' date in Work Experience 1 and type '122024' — the field auto-advances from month to year";

  it("leaves the only rendered From group untouched when the step targets To", () => {
    expect(
      resolveSegmentedDateGroup("'To' date in Work Experience 1, '122024'", [
        g("Work Experience 1 From", [12, 9999]),
      ])
    ).toBeNull();
  });

  it("does not let prose 'from' pick a From group of another section for a To step", () => {
    expect(
      resolveSegmentedDateGroup(PROSE_TO_STEP, [
        g("Work Experience 1 From", [12, 9999]),
        g("Education 1 From", [12, 9999]),
        g("Education 1 To", [12, 9999]),
      ])
    ).toBeNull();
  });

  it("does not write a To value into a group labelled only Start date", () => {
    expect(
      resolveSegmentedDateGroup("Enter '122024' as the Job 1 To date", [
        g("Job 1 Start date", [12, 9999]),
      ])
    ).toBeNull();
  });

  it("types an unquoted To step into the To group among From and To", () => {
    const groups = [g("Job 1 From", [12, 9999]), g("Job 1 To", [12, 9999])];
    expect(resolveSegmentedDateGroup("Enter '122024' as the Job 1 To date", groups)).toBe(1);
    expect(resolveSegmentedDateGroup(PROSE_TO_STEP, groups)).toBe(1);
  });

  it("leaves a lone To year group untouched when the step names the From year", () => {
    expect(
      resolveSegmentedDateGroup("Type '2015' into the From Year spinbutton of Education 1", [
        g("Education 1 To", [9999]),
      ])
    ).toBeNull();
  });

  it("still targets a lone group when the step names no field", () => {
    expect(resolveSegmentedDateGroup("type '012020'", [g("Employment period", [12, 9999])])).toBe(
      0
    );
  });

  it("prefers the standalone group over a nested slice of another widget when no section separates them", () => {
    // Groups exactly as a multi-section form enumerated them live:
    // no section heading visible, the Work Experience From widget [12, 9999] also
    // surfaces its Year wrapper as a nested [9999] group labelled "From*".
    const live: SegmentedDateGroup[] = [
      { segmentMaxes: [12, 9999], context: "From* From*", label: "From*", section: "From*" },
      { segmentMaxes: [9999], context: "From* From*", label: "From*", section: "From*" },
      {
        segmentMaxes: [9999],
        context: "To (Actual or Expected)* To (Actual or Expected)*",
        label: "To (Actual or Expected)*",
        section: "To (Actual or Expected)*",
      },
      {
        segmentMaxes: [12],
        context: "From* From*",
        label: "From*",
        section: "From*",
        nested: true,
      },
      {
        segmentMaxes: [9999],
        context: "From* From*",
        label: "From*",
        section: "From*",
        nested: true,
      },
    ];
    expect(
      resolveSegmentedDateGroup(
        "Click the Year spinbutton in the 'From' date of Education 1 and type '2016'",
        live
      )
    ).toBe(1);
    expect(
      resolveSegmentedDateGroup(
        "Click the Year spinbutton in the 'To' date of Education 1 and type '2020'",
        live
      )
    ).toBe(2);
  });

  it("still refuses a tie between two standalone groups", () => {
    const twins: SegmentedDateGroup[] = [
      { segmentMaxes: [9999], context: "From", label: "From" },
      { segmentMaxes: [9999], context: "From", label: "From" },
    ];
    expect(resolveSegmentedDateGroup("type '2016' into the 'From' date", twins)).toBeNull();
  });
});
