import { describe, expect, it } from "vitest";
import { EMPTY_VOCABULARY, type ReconVocabulary } from "@/recon/vocabulary";
import { emitBrowserFlowTs, emitContractTs } from "@/scripts/recon-generate";

const vocabulary: ReconVocabulary = {
  ...EMPTY_VOCABULARY,
  subject: /./,
  table: [
    [/\b(mobile phone|primary phone|phone number|mobile)\b/i, "MobilePhone"],
    [/\b(street address|address line 1)\b/i, "AddressLine1"],
  ],
};

const browserFlowOpts = {
  siteId: "test-site",
  pascal: "TestSite",
  baseUrl: "https://api.example.com",
  flowSteps: ["Fill 'Phone Number' with '555'", "Fill 'Address Line 1' with '1 Main'"],
  isSubmissionFlow: true,
  browserFlowOnly: false,
  inputBody: { FirstName: "Reginald" },
  vocabulary,
};

describe("unread-field fallback re-emit parity", () => {
  it("splices the same canonical names and applicant decision as the first emit and the contract", () => {
    const first = emitBrowserFlowTs(browserFlowOpts);
    const fallback = emitBrowserFlowTs({
      ...browserFlowOpts,
      capturedFallbackFields: new Set(["Phone", "AddressLine"]),
    });

    expect([...first.payloadFieldNames].sort()).toEqual(["AddressLine", "Phone"]);
    expect([...fallback.payloadFieldNames].sort()).toEqual([...first.payloadFieldNames].sort());
    expect(fallback.code).toContain("payload.Phone");
    expect(fallback.code).toContain("payload.AddressLine");
    expect(fallback.code).not.toContain("MobilePhone");
    expect(fallback.code).not.toContain("AddressLine1");

    const contract = emitContractTs({
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
      isSubmissionFlow: true,
      omitExecuteHttp: false,
      inputBody: browserFlowOpts.inputBody,
      payloadFieldNames: fallback.payloadFieldNames,
      optionalPayloadFieldNames: fallback.optionalPayloadFieldNames,
    });
    expect(contract).toContain("ApplicantContactSchema.extend(");
    expect(contract).not.toContain("MobilePhone");
    expect(contract).not.toContain("AddressLine1");
  });
});
