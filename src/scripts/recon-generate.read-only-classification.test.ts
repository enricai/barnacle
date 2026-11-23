import { describe, expect, it } from "vitest";
import { EMPTY_VOCABULARY, type ReconVocabulary } from "@/recon/vocabulary";
import { emitBrowserFlowTs, emitContractTs } from "@/scripts/recon-generate";

const base = {
  siteId: "test-site",
  pascal: "TestSite",
  baseUrl: "https://api.example.com",
  baseHeaders: {},
  minTime: 100,
  safeRps: 10,
  responseBody: {},
  auxFiles: [],
  payloadFieldNames: new Set<string>(),
};

describe("read-only flows are not job applications", () => {
  it("GraphQL query flow emits no applicant/tracking schema or multipart", () => {
    const source = emitContractTs({
      ...base,
      gql: true,
      gqlQuery: "query Jobs { jobs { id } }",
      endpointPath: "/graphql",
      isSubmissionFlow: false,
      inputBody: { query: "query Jobs { jobs { id } }", variables: { email: "a@b.c" } },
      hasMultipartStep: true,
    } as never);
    expect(source).not.toContain("ApplicantContactSchema");
    expect(source).not.toContain("JobTrackingSchema");
    expect(source).not.toContain("multipart: true");
  });

  it("a mutation/submission flow is unchanged", () => {
    const source = emitContractTs({
      ...base,
      gql: false,
      gqlQuery: null,
      endpointPath: "/apply",
      omitExecuteHttp: true,
      isSubmissionFlow: true,
    } as never);
    expect(source).toContain("ApplicantContactSchema");
    expect(source).toContain(".merge(JobTrackingSchema)");
    expect(source).toContain("multipart: true");
  });

  const cap = (method: string) => ({
    timestamp: "",
    phase: "",
    method,
    url: "https://api.example.com/jobs",
    status: 200,
    requestHeaders: {},
    requestPostData: null,
    responseHeaders: {},
    responseBody: {},
    operationName: null,
    query: null,
    variables: null,
    decodedParams: null,
  });

  it("actionSteps with only GET captures are read-only; a POST capture is not", () => {
    const common = {
      ...base,
      gql: false,
      gqlQuery: null,
      endpointPath: "/jobs",
      isSubmissionFlow: false,
      inputBody: { email: "a@b.c" },
    };
    const ro = emitContractTs({ ...common, actionSteps: [{ capture: cap("GET") }] } as never);
    expect(ro).not.toContain("ApplicantContactSchema");
    const rw = emitContractTs({ ...common, actionSteps: [{ capture: cap("POST") }] } as never);
    expect(rw).toContain("ApplicantContactSchema");
  });

  it("browser-flow emitter payload keys agree with the read-only contract", () => {
    const vocabulary: ReconVocabulary = {
      ...EMPTY_VOCABULARY,
      subject: /./,
      table: [[/\b(phone number|mobile)\b/i, "MobilePhone"]],
    };
    const { payloadFieldNames } = emitBrowserFlowTs({
      siteId: "test-site",
      pascal: "TestSite",
      baseUrl: "https://api.example.com",
      flowSteps: ["Fill 'Phone Number' with '555'"],
      isSubmissionFlow: false,
      inputBody: { email: "a@b.c" },
      vocabulary,
    });
    expect([...payloadFieldNames]).toEqual(["MobilePhone"]);
  });
});
