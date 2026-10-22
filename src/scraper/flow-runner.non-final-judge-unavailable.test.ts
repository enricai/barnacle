import { describe, expect, it } from "vitest";
import { isNullVerdictAdvanceCredited } from "@/scraper/flow-runner";

const BASE = {
  midFlowSubmit: true,
  judgeUnavailable: true,
  networkAdvanced: false,
  pageAdvanced: false,
  invalidMarkerCount: 0,
};

describe("isNullVerdictAdvanceCredited", () => {
  it("credits a non-final step on a real network advance", () => {
    expect(isNullVerdictAdvanceCredited({ ...BASE, networkAdvanced: true })).toBe(true);
  });

  it("credits a non-final step on a demonstrable page advance", () => {
    expect(isNullVerdictAdvanceCredited({ ...BASE, pageAdvanced: true })).toBe(true);
  });

  it("does not credit with weak signals", () => {
    expect(isNullVerdictAdvanceCredited(BASE)).toBe(false);
  });

  it("does not credit a final step", () => {
    expect(
      isNullVerdictAdvanceCredited({ ...BASE, midFlowSubmit: false, networkAdvanced: true })
    ).toBe(false);
  });

  it("does not credit when the judge produced a verdict", () => {
    expect(
      isNullVerdictAdvanceCredited({ ...BASE, judgeUnavailable: false, pageAdvanced: true })
    ).toBe(false);
  });

  it("credits a page advance despite invalid markers on the new page", () => {
    expect(
      isNullVerdictAdvanceCredited({ ...BASE, pageAdvanced: true, invalidMarkerCount: 2 })
    ).toBe(true);
  });

  it("does not credit a network-only advance while invalid markers remain", () => {
    expect(
      isNullVerdictAdvanceCredited({ ...BASE, networkAdvanced: true, invalidMarkerCount: 2 })
    ).toBe(false);
  });
});
