import { expect, it } from "vitest";
import { classifySubmissionFlow } from "@/scripts/recon-generate";

const base = {
  noReplayableActionFlow: true,
  isReadOnlyGetFlow: false,
  actionStepCount: 0,
  gql: false,
  actionCaptureMethods: ["GET"],
  graphqlActionSequenceHasMutation: false,
};

it("a reads-only recording is not a submission unless a step is the submit", () => {
  expect(classifySubmissionFlow(base)).toBe(false);
  expect(classifySubmissionFlow({ ...base, declaresSubmitStep: true })).toBe(true);
  expect(classifySubmissionFlow({ ...base, actionCaptureMethods: ["POST"] })).toBe(true);
});
