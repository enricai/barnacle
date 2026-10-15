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

  describe("own-label matching", () => {
    const YEAR_STEP = "Click the Year spinbutton in the 'From' date of Education 1 and type '2015'";
    const TO_STEP =
      "Click the 'MM' month part of the 'To' date in Work Experience 1 and type '122024' in one go — the date field auto-advances from month to year";
    const own = (ownLabel: string, context = "Education 1"): SegmentedDateGroup => ({
      segmentMaxes: [9999],
      context,
      ownLabel,
    });
    const own2 = (ownLabel: string): SegmentedDateGroup => ({
      segmentMaxes: [12, 9999],
      context: `Work Experience 1 ${ownLabel}`,
      ownLabel,
    });

    it("resolves a Year step only to the group whose own label has 'From'", () => {
      expect(resolveSegmentedDateGroup(YEAR_STEP, [own("To"), own("From")])).toBe(1);
    });

    it("returns null for a lone group labelled otherwise", () => {
      expect(resolveSegmentedDateGroup(YEAR_STEP, [own("Graduation")])).toBeNull();
    });

    it("matches the own label as a whole word, not a substring", () => {
      expect(resolveSegmentedDateGroup(YEAR_STEP, [own("Fromage")])).toBeNull();
    });

    it("keeps resolving the 'To' group for the MM/To step", () => {
      expect(resolveSegmentedDateGroup(TO_STEP, [own2("From"), own2("To")])).toBe(1);
    });

    it("does not let the prose word 'from' select a From group", () => {
      expect(resolveSegmentedDateGroup(TO_STEP, [own2("From")])).toBeNull();
    });

    it("ignores MM/Year part labels when deciding candidacy", () => {
      const step = "Click the 'Year' spinbutton and type '2015'";
      expect(resolveSegmentedDateGroup(step, [own("Graduation")])).toBe(0);
    });
  });
});
