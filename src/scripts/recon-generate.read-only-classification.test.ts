import { describe, expect, it } from "vitest";
import { emitContractTs } from "@/scripts/recon-generate";

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
});
