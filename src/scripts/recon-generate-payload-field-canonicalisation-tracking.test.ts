import { describe, expect, it } from "vitest";
import { z } from "zod/v4";
import { ApplicantContactSchema } from "@/lib/applicant-payload";
import { JobTrackingSchema } from "@/lib/job-tracking";
import { EMPTY_VOCABULARY, type ReconVocabulary } from "@/recon/vocabulary";
import {
  emitBrowserFlowTs,
  emitConfigManifest,
  emitContractTs,
  resolveStepPayloadField,
} from "@/scripts/recon-generate";

/**
 * Locks that label-derived vocabulary names are canonicalised onto
 * ApplicantContactSchema keys across the contract, the flow, and the manifest,
 * and that JobTrackingSchema is composed into a job-application contract so TrackingUrl survives parse.
 */

const VOCAB: ReconVocabulary = {
  ...EMPTY_VOCABULARY,
  subject: /./,
  table: [
    [/\b(mobile phone|phone number)\b/i, "MobilePhone"],
    [/\b(street address|address line 1)\b/i, "AddressLine1"],
  ],
};

const PHONE_STEP = "Fill in the Mobile Phone field with '555'";
const ADDRESS_STEP = "Fill in the Street Address field with '1 Main'";
const STEPS = [PHONE_STEP, ADDRESS_STEP];

const canonicalFields = (): Set<string> =>
  new Set(
    STEPS.map((s) => resolveStepPayloadField(s, undefined, false, VOCAB, undefined, true) as string)
  );

function emitContract(fields: Set<string>): string {
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
    isSubmissionFlow: true,
    payloadFieldNames: fields,
  });
}

function evalSchema(source: string): z.ZodObject {
  const block = /const \w+PayloadSchema = ([\s\S]*?\n\}\)\.merge\(JobTrackingSchema\));/.exec(
    source
  );
  if (!block) throw new Error("payload schema block not found in emitted contract");
  return new Function(
    "z",
    "ApplicantContactSchema",
    "JobTrackingSchema",
    "multipartJsonObject",
    `return ${block[1]};`
  )(z, ApplicantContactSchema, JobTrackingSchema, (s: z.ZodType) => s) as z.ZodObject;
}

describe("label-derived payload field canonicalisation", () => {
  it("resolves vocabulary names onto ApplicantContactSchema keys", () => {
    const fields = [...canonicalFields()];
    const baseKeys = Object.keys(ApplicantContactSchema.shape);

    expect(fields).toHaveLength(2);
    for (const f of fields) expect(baseKeys).toContain(f);
    expect(fields).not.toContain("MobilePhone");
    expect(fields).not.toContain("AddressLine1");
  });

  it("emits a contract with no non-canonical required keys", () => {
    const source = emitContract(canonicalFields());

    expect(source).not.toMatch(/\bMobilePhone\b/);
    expect(source).not.toMatch(/\bAddressLine1\b/);
    const shape = evalSchema(source).shape;
    expect(Object.keys(shape)).not.toContain("MobilePhone");
    expect(Object.keys(shape)).not.toContain("AddressLine1");
  });

  it("splices the same canonical name the contract declares", () => {
    const [phone, address] = [...canonicalFields()] as [string, string];
    const { code } = emitBrowserFlowTs({
      siteId: "test-agency",
      pascal: "TestAgency",
      baseUrl: "https://example.com",
      isSubmissionFlow: true,
      browserFlowOnly: true,
      vocabulary: VOCAB,
      flowSteps: STEPS,
    });

    expect(code).toContain(`\${payload.${phone}}`);
    expect(code).toContain(`\${payload.${address}}`);
    expect(code).not.toContain("payload.MobilePhone");
    expect(code).not.toContain("payload.AddressLine1");
  });

  it("keeps canonical names in the unread-field fallback re-emit", () => {
    const opts = {
      siteId: "test-agency",
      pascal: "TestAgency",
      baseUrl: "https://example.com",
      isSubmissionFlow: true,
      browserFlowOnly: false,
      inputBody: { Phone: "555", AddressLine: "1 Main" },
      vocabulary: VOCAB,
      flowSteps: STEPS,
    };
    const first = emitBrowserFlowTs(opts);
    const fallback = emitBrowserFlowTs({
      ...opts,
      capturedFallbackFields: new Set([...first.payloadFieldNames]),
    });

    expect([...fallback.payloadFieldNames].sort()).toEqual([...first.payloadFieldNames].sort());
    expect([...fallback.payloadFieldNames]).not.toContain("MobilePhone");
    expect([...fallback.payloadFieldNames]).not.toContain("AddressLine1");
    expect(fallback.code).not.toContain("payload.MobilePhone");
  });

  it("agrees with the config manifest request template", () => {
    const [phone, address] = [...canonicalFields()] as [string, string];
    const manifest = JSON.parse(
      emitConfigManifest({
        siteId: "acme-demo",
        displayName: "AcmeDemo",
        baseUrl: "https://apply.acme.example",
        isSubmissionFlow: true,
        browserFlowOnly: true,
        vocabulary: VOCAB,
        flowSteps: STEPS,
      } as never)
    ) as {
      spec: {
        request?: { properties?: Record<string, unknown> };
        flow: { steps: (string | { step: string })[] };
      };
    };
    const steps = manifest.spec.flow.steps.map((s) => (typeof s === "string" ? s : s.step));

    expect(steps.join("\n")).toContain(`{{ .request.${phone} }}`);
    expect(steps.join("\n")).toContain(`{{ .request.${address} }}`);
    expect(steps.join("\n")).not.toMatch(/\.request\.(MobilePhone|AddressLine1)\b/);
    const props = Object.keys(manifest.spec.request?.properties ?? {});
    expect(props).not.toContain("MobilePhone");
    expect(props).not.toContain("AddressLine1");
  });
});

describe("JobTrackingSchema composition", () => {
  it("imports JobTrackingSchema and retains TrackingUrl through parse", () => {
    const source = emitContract(canonicalFields());
    expect(source).toContain('import { JobTrackingSchema } from "');

    const schema = evalSchema(source);
    expect(Object.keys(schema.shape)).toEqual(
      expect.arrayContaining(Object.keys(JobTrackingSchema.shape))
    );
    const trackingKey = Object.keys(JobTrackingSchema.shape).includes("TrackingUrl");
    expect(trackingKey).toBe(true);

    const base = Object.fromEntries(
      Object.entries(ApplicantContactSchema.shape).map(([k, v]) => [
        k,
        (v as z.ZodType).safeParse("x").success ? "x" : undefined,
      ])
    );
    const result = schema.safeParse({
      ...base,
      Resume: Buffer.from("x"),
      Answers: {},
      Email: "a@b.co",
      ClickUrl: "https://x.test/a",
      TrackingUrl: "https://t.example/a",
    });
    expect(result.success ? [] : result.error.issues).toEqual([]);
    expect(result.success && (result.data as Record<string, unknown>).TrackingUrl).toBe(
      "https://t.example/a"
    );
  });
});
