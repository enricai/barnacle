import { describe, expect, it } from "vitest";
import { ApplicantContactSchema } from "@/lib/applicant-payload";
import { EMPTY_VOCABULARY, type ReconVocabulary } from "@/recon/vocabulary";
import { emitContractTs, resolveStepPayloadField } from "@/scripts/recon-generate";

const vocabulary: ReconVocabulary = {
  ...EMPTY_VOCABULARY,
  subject: /./,
  table: [
    [/\b(mobile phone|primary phone|phone number|mobile)\b/i, "MobilePhone"],
    [/\b(street address|address line 1)\b/i, "AddressLine1"],
    [/\bnickname\b/i, "Nickname"],
  ],
};

describe("resolveStepPayloadField — canonical payload field names", () => {
  it("maps vocabulary aliases onto ApplicantContactSchema keys, leaving explicit and custom names alone", () => {
    expect(
      resolveStepPayloadField("Fill 'Phone Number' with '555'", undefined, false, vocabulary)
    ).toBe("Phone");
    expect(
      resolveStepPayloadField("Fill 'Address Line 1' with '1 Main'", undefined, false, vocabulary)
    ).toBe("AddressLine");
    expect(
      resolveStepPayloadField("Fill 'Nickname' with 'Bob'", undefined, false, vocabulary)
    ).toBe("Nickname");
    expect(
      resolveStepPayloadField("Fill 'Phone Number' with '555'", "MobilePhone", false, vocabulary)
    ).toBe("MobilePhone");
  });

  it("emits a schema with no extra required keys beyond the base schema's", () => {
    const fields = new Set(
      ["Fill 'Phone Number' with '555'", "Fill 'Address Line 1' with '1 Main'"].map(
        (s) => resolveStepPayloadField(s, undefined, false, vocabulary) as string
      )
    );
    const source = emitContractTs({
      siteId: "test-site",
      pascal: "TestSite",
      baseUrl: "https://api.example.com",
      baseHeaders: {},
      minTime: 100,
      safeRps: 10,
      responseBody: {},
      gql: false,
      gqlQuery: null,
      endpointPath: "/apply",
      auxFiles: [],
      multiStepBody: undefined,
      omitExecuteHttp: true,
      isSubmissionFlow: true,
      payloadFieldNames: fields,
    });
    const block = source.match(
      /const \w+PayloadSchema = ApplicantContactSchema\.extend\(\{[\s\S]*?\n\}\);/
    );
    expect(block).not.toBeNull();
    expect(block![0]).not.toContain("MobilePhone:");
    expect(block![0]).not.toContain("AddressLine1: z.string()");

    const extraKeys = [...block![0].matchAll(/^ {2}(\w+): /gm)].map((m) => m[1]);
    expect(extraKeys.sort()).toEqual(["Answers", "ClickUrl", "Email"].sort());
    expect(Object.keys(ApplicantContactSchema.shape)).toEqual(
      expect.arrayContaining(["Phone", "AddressLine"])
    );
  });
});
