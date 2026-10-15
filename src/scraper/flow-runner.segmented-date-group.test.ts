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
