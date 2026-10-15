import { describe, expect, it } from "vitest";
import {
  parseSegmentedDateValue,
  resolveSegmentedDateGroup,
  type SegmentedDateGroup,
} from "@/scraper/flow-runner";

const GROUPS: SegmentedDateGroup[] = [
  { segmentMaxes: [12, 9999], context: "Work Experience 1 From" },
  { segmentMaxes: [12, 9999], context: "Work Experience 1 To" },
  { segmentMaxes: [9999], context: "Education 1 From" },
  { segmentMaxes: [9999], context: "Education 1 To" },
];

describe("flow-runner/segmented date group resolution", () => {
  it("resolves each step to its group", () => {
    expect(resolveSegmentedDateGroup("'From' date in Work Experience 1, '012020'", GROUPS)).toBe(0);
    expect(resolveSegmentedDateGroup("'From' date of Education 1, '2016'", GROUPS)).toBe(2);
    expect(resolveSegmentedDateGroup("'To' date of Education 1, '2020'", GROUPS)).toBe(3);
  });

  it("returns null on a tie", () => {
    const tied = [GROUPS[2], GROUPS[2]] as SegmentedDateGroup[];
    expect(resolveSegmentedDateGroup("Enter '2016' in the date", tied)).toBeNull();
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
