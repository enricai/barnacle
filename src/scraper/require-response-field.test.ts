import { describe, expect, it } from "vitest";

import { HttpSchemaError } from "@/scraper/errors";
import { requireFirstItemField, requireResponseField } from "@/scraper/require-response-field";

describe("requireResponseField", () => {
  it("returns the value when the field is present", () => {
    const result = requireResponseField<string>({ AccessCode: "abc123" }, "AccessCode", "Tokens");
    expect(result).toBe("abc123");
  });

  it("returns numeric values when the field is present", () => {
    const result = requireResponseField<number>({ APPDraftId: 42 }, "APPDraftId", "Drafts");
    expect(result).toBe(42);
  });

  it("throws HttpSchemaError with contextLabel when the field is undefined", () => {
    expect(() =>
      requireResponseField<string>({ other: "value" }, "AccessCode", "VerificationTokens")
    ).toThrow(HttpSchemaError);
    expect(() =>
      requireResponseField<string>({ other: "value" }, "AccessCode", "VerificationTokens")
    ).toThrow("VerificationTokens missing AccessCode");
  });

  it("throws HttpSchemaError with contextLabel when the field is null", () => {
    expect(() =>
      requireResponseField<string>({ AccessCode: null }, "AccessCode", "VerificationTokens")
    ).toThrow(HttpSchemaError);
    expect(() =>
      requireResponseField<string>({ AccessCode: null }, "AccessCode", "VerificationTokens")
    ).toThrow("VerificationTokens missing AccessCode");
  });

  it("throws HttpSchemaError with contextLabel when the key is missing entirely", () => {
    expect(() =>
      requireResponseField<number>({}, "APPDraftId", "JobApplicationDrafts POST")
    ).toThrow(HttpSchemaError);
    expect(() =>
      requireResponseField<number>({}, "APPDraftId", "JobApplicationDrafts POST")
    ).toThrow("JobApplicationDrafts POST missing APPDraftId");
  });
});

describe("requireFirstItemField", () => {
  it("returns items[0][key] when present", () => {
    const result = requireFirstItemField<number>(
      { items: [{ LegalDescriptionVersionId: 99 }] },
      "LegalDescriptionVersionId",
      "ApplyFlows"
    );
    expect(result).toBe(99);
  });

  it("throws HttpSchemaError when items is an empty array", () => {
    expect(() =>
      requireFirstItemField<number>({ items: [] }, "LegalDescriptionVersionId", "ApplyFlows")
    ).toThrow(HttpSchemaError);
    expect(() =>
      requireFirstItemField<number>({ items: [] }, "LegalDescriptionVersionId", "ApplyFlows")
    ).toThrow("ApplyFlows missing items");
  });

  it("throws HttpSchemaError when items is undefined", () => {
    expect(() =>
      requireFirstItemField<number>({}, "LegalDescriptionVersionId", "ApplyFlows")
    ).toThrow(HttpSchemaError);
    expect(() =>
      requireFirstItemField<number>({}, "LegalDescriptionVersionId", "ApplyFlows")
    ).toThrow("ApplyFlows missing items");
  });

  it("throws HttpSchemaError when items[0][key] is null", () => {
    expect(() =>
      requireFirstItemField<number>(
        { items: [{ LegalDescriptionVersionId: null }] },
        "LegalDescriptionVersionId",
        "ApplyFlows"
      )
    ).toThrow(HttpSchemaError);
    expect(() =>
      requireFirstItemField<number>(
        { items: [{ LegalDescriptionVersionId: null }] },
        "LegalDescriptionVersionId",
        "ApplyFlows"
      )
    ).toThrow("ApplyFlows missing LegalDescriptionVersionId");
  });

  it("throws HttpSchemaError when items[0][key] is undefined", () => {
    expect(() =>
      requireFirstItemField<number>({ items: [{ other: "value" }] }, "QuestionnaireId", "Questions")
    ).toThrow(HttpSchemaError);
    expect(() =>
      requireFirstItemField<number>({ items: [{ other: "value" }] }, "QuestionnaireId", "Questions")
    ).toThrow("Questions missing QuestionnaireId");
  });
});
