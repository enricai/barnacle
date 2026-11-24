import { describe, expect, it } from "vitest";

import { classifySubmissionFlow } from "@/scripts/recon-generate";

const base = {
  noReplayableActionFlow: true,
  isReadOnlyGetFlow: false,
  actionStepCount: 0,
  gql: false,
  actionCaptureMethods: [],
  graphqlActionSequenceHasMutation: false,
};

describe("classifySubmissionFlow", () => {
  it("forces submission for a no-action-sequence flow by default", () => {
    expect(classifySubmissionFlow(base)).toBe(true);
  });
  it("does not force submission when the declared flow is read-only", () => {
    expect(classifySubmissionFlow({ ...base, isDeclaredReadOnlyFlow: true })).toBe(false);
  });
  it("a declared mutation flow still classifies as submission", () => {
    expect(classifySubmissionFlow({ ...base, isDeclaredReadOnlyFlow: false })).toBe(true);
  });
});
