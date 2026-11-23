import { describe, expect, it } from "vitest";
import { contractUsesApplicantContactSchema } from "@/scripts/recon-generate";

const base = { isSubmissionFlow: true, browserFlowOnly: true };
const plain = new Set(["time", "players", "name", "email"]);

describe("contractUsesApplicantContactSchema (browser-only decision)", () => {
  it("is false for a booking flow with no applicant evidence", () => {
    expect(
      contractUsesApplicantContactSchema({
        ...base,
        payloadFieldNames: plain,
        flowSteps: ["Pick a table time", { step: "Click Reserve", submitStep: true }],
      })
    ).toBe(false);
  });
  it("is true on explicit declaration, upload step, or resume vocabulary", () => {
    expect(
      contractUsesApplicantContactSchema({
        ...base,
        payloadFieldNames: plain,
        applicantContract: true,
      })
    ).toBe(true);
    expect(
      contractUsesApplicantContactSchema({
        ...base,
        flowSteps: [{ step: "Choose file", upload: true }],
      })
    ).toBe(true);
    expect(contractUsesApplicantContactSchema({ ...base, hasMultipartStep: true })).toBe(true);
    expect(contractUsesApplicantContactSchema({ ...base, flowSteps: ["Attach your resume"] })).toBe(
      true
    );
  });
  it("explicit false overrides evidence", () => {
    expect(
      contractUsesApplicantContactSchema({
        ...base,
        applicantContract: false,
        hasMultipartStep: true,
        flowSteps: ["Attach your resume"],
      })
    ).toBe(false);
  });
});
