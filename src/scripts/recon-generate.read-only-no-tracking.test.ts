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
  gql: false,
  gqlQuery: null,
  endpointPath: "/search",
  auxFiles: [],
  omitExecuteHttp: true,
  payloadFieldNames: new Set<string>(),
};

describe("JobTrackingSchema merge", () => {
  it("is omitted for a read-only GET flow", () => {
    const source = emitContractTs({
      ...base,
      isSubmissionFlow: false,
      getInputModel: { dynamicFields: [{ field: "q" }], pathVars: [], fixedParams: {} },
    } as never);
    expect(source).not.toContain("JobTrackingSchema");
    expect(source).not.toContain("TrackingUrl");
  });

  it("is kept for a submission flow", () => {
    const source = emitContractTs({ ...base, isSubmissionFlow: true });
    expect(source).toContain(".merge(JobTrackingSchema)");
    expect(source).toContain("lib/job-tracking");
  });
});
