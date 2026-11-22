import { describe, expect, it } from "vitest";
import { unreadContractSchemaFieldChecklistLines } from "./recon-generate";

describe("unreadContractSchemaFieldChecklistLines", () => {
  const base = "const S = ApplicantContactSchema.extend({});\n";
  it("flags unread Resume/Answers/ClickUrl", () => {
    expect(unreadContractSchemaFieldChecklistLines(base)).toHaveLength(3);
  });
  it("is silent for fields the contract reads", () => {
    const code = `${base}x(payload.Resume, payload.Answers["a"], payload.ClickUrl);`;
    expect(unreadContractSchemaFieldChecklistLines(code)).toEqual([]);
  });
  it("ignores non-applicant contracts", () => {
    expect(unreadContractSchemaFieldChecklistLines("const x = 1;")).toEqual([]);
  });
});
