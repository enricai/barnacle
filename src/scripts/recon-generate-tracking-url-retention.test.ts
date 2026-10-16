import { describe, expect, it } from "vitest";
import { z } from "zod/v4";
import { ApplicantContactSchema } from "@/lib/applicant-payload";
import { JobTrackingSchema } from "@/lib/job-tracking";
import { emitContractTs } from "@/scripts/recon-generate";

const TRACKING_URL = "https://track.example.com/c/1";

function emit(isSubmissionFlow: boolean): string {
  return emitContractTs({
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
    isSubmissionFlow,
    payloadFieldNames: new Set<string>(),
  });
}

function evalPayloadSchema(source: string): z.ZodType {
  const block = /const \w+PayloadSchema = ([\s\S]*?\.merge\(JobTrackingSchema\));/.exec(source);
  if (!block) throw new Error("payload schema block not found in emitted contract");
  return new Function(
    "z",
    "ApplicantContactSchema",
    "JobTrackingSchema",
    "multipartJsonObject",
    `return ${block[1]};`
  )(z, ApplicantContactSchema, JobTrackingSchema, (s: z.ZodType) => s) as z.ZodType;
}

describe("emitContractTs — TrackingUrl retained after parse", () => {
  it("retains TrackingUrl for a non-applicant browser-flow-only contract", () => {
    const source = emit(false);
    expect(source).not.toContain("ApplicantContactSchema");
    const parsed = evalPayloadSchema(source).safeParse({ query: "x", TrackingUrl: TRACKING_URL });
    expect(parsed.success, JSON.stringify(!parsed.success && parsed.error.issues)).toBe(true);
    expect((parsed.data as Record<string, unknown>).TrackingUrl).toBe(TRACKING_URL);
  });

  it("retains TrackingUrl for an applicant contract", () => {
    const source = emit(true);
    expect(source).toContain("ApplicantContactSchema");
    const shape = (evalPayloadSchema(source) as z.ZodObject).shape;
    expect(Object.keys(shape)).toContain("TrackingUrl");
  });
});
