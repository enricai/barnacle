import { describe, expect, it } from "vitest";
import { z } from "zod/v4";
import { ApplicantContactSchema } from "@/lib/applicant-payload";
import { JobTrackingSchema } from "@/lib/job-tracking";
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
      /const \w+PayloadSchema = ApplicantContactSchema\.extend\(\{[\s\S]*?\n\}\)(?:\.extend\(JobTrackingSchema\.shape\))?;/
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

describe("emitContractTs — generate and safeParse", () => {
  it("emits a payload schema that accepts base-schema fields plus Email and ClickUrl only", () => {
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
      /const (\w+PayloadSchema) = (ApplicantContactSchema\.extend\(\{[\s\S]*?\n\}\)(?:\.extend\(JobTrackingSchema\.shape\))?);/
    );
    expect(block).not.toBeNull();
    const schema = new Function(
      "z",
      "ApplicantContactSchema",
      "JobTrackingSchema",
      "multipartJsonObject",
      `return ${block![2]};`
    )(z, ApplicantContactSchema, JobTrackingSchema, (s: z.ZodType) => s) as z.ZodType;
    const base = Object.fromEntries(
      Object.entries(ApplicantContactSchema.shape).map(([k, v]) => {
        const parsed = (v as z.ZodType).safeParse("x");
        return [k, parsed.success ? "x" : undefined];
      })
    );
    const result = schema.safeParse({
      ...base,
      Resume: Buffer.from("x"),
      Answers: {},
      Email: "a@b.co",
      ClickUrl: "https://x.test/a",
    });
    expect(result.success ? [] : result.error.issues).toEqual([]);
  });
});

describe("emitContractTs — TrackingUrl composition", () => {
  const emit = (isSubmissionFlow: boolean, omitExecuteHttp: boolean): string =>
    emitContractTs({
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
      omitExecuteHttp,
      isSubmissionFlow,
      payloadFieldNames: new Set<string>(),
    });

  it.each([
    ["applicant base", true, true],
    ["empty object base", false, true],
    ["query base", false, false],
  ])(
    "imports JobTrackingSchema and retains TrackingUrl on parse (%s)",
    (_name, submission, omit) => {
      const source = emit(submission, omit);
      expect(source).toContain('import { JobTrackingSchema } from "');
      expect(source).toContain(".extend(JobTrackingSchema.shape)");
      const block = source.match(
        /const (\w+PayloadSchema) = ([\s\S]*?\.extend\(JobTrackingSchema\.shape\));/
      );
      expect(block).not.toBeNull();
      const schema = new Function(
        "z",
        "ApplicantContactSchema",
        "JobTrackingSchema",
        "multipartJsonObject",
        `return ${block![2]};`
      )(z, ApplicantContactSchema, JobTrackingSchema, (s: z.ZodType) => s) as z.ZodType;
      const shape = (schema as unknown as { shape: Record<string, unknown> }).shape;
      expect(Object.keys(shape)).toContain("TrackingUrl");
    }
  );
});
