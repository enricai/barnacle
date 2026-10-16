import { describe, expect, it } from "vitest";
import { z } from "zod/v4";
import { ApplicantContactSchema } from "@/lib/applicant-payload";
import { JobTrackingSchema } from "@/lib/job-tracking";
import type { ReconFormSchema } from "@/recon/form-schema";
import { EMPTY_VOCABULARY, type ReconVocabulary } from "@/recon/vocabulary";
import {
  detectFormSchemaFieldNames,
  emitBrowserFlowTs,
  emitContractTs,
} from "@/scripts/recon-generate";

const vocabulary: ReconVocabulary = {
  ...EMPTY_VOCABULARY,
  subject: /./,
  table: [
    [/\b(mobile phone|primary phone|phone number|mobile)\b/i, "MobilePhone"],
    [/\b(street address|address line 1)\b/i, "AddressLine1"],
  ],
};

const FLOW_STEPS = ["Fill 'Phone Number' with '555'", "Fill 'Address Line 1' with '1 Main'"];

const FIELD_ID = "11111111-1111-1111-1111-111111111111";
const FORM_SCHEMA: ReconFormSchema = {
  fieldIdKey: "FieldId",
  fieldNameKeys: ["FieldSourceCode", "FieldName"],
  fieldOptionsKey: "FieldOptions",
  optionIdKey: "Id",
  optionValueKey: "Value",
  responseValueKey: "Value",
  responseOptionIdKey: "OptionId",
};
const formSchemaCapture = {
  timestamp: "2024-01-01T00:00:00Z",
  phase: "action" as const,
  method: "GET",
  url: "https://example.com/schema",
  status: 200,
  requestHeaders: {},
  requestPostData: null,
  responseHeaders: {},
  responseBody: [{ FieldId: FIELD_ID, FieldName: "Address Line 1" }],
  operationName: null,
  query: null,
  variables: null,
  decodedParams: null,
};

const EXPECTED_EXTRA_KEYS = ["Answers", "ClickUrl", "Email"];

const emit = (overrides: Partial<Parameters<typeof emitContractTs>[0]>): string =>
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
    isSubmissionFlow: true,
    ...overrides,
  });

const payloadBlock = (source: string): string => {
  const match = source.match(
    /const \w+PayloadSchema = ApplicantContactSchema\.extend\(\{[\s\S]*?\n\}\)(?:\.merge\(JobTrackingSchema\))?;/
  );
  expect(match).not.toBeNull();
  return match![0];
};

const extraKeys = (block: string): string[] =>
  [...block.matchAll(/^ {2}(\w+): /gm)].map((m) => m[1] as string).sort();

const compileSchema = (block: string): z.ZodType => {
  const expr = block.replace(/^const \w+ = /, "").replace(/;$/, "");
  return new Function(
    "z",
    "ApplicantContactSchema",
    "JobTrackingSchema",
    "multipartJsonObject",
    `return ${expr};`
  )(z, ApplicantContactSchema, JobTrackingSchema, (s: z.ZodType) => s) as z.ZodType;
};

const realPayload = (): Record<string, unknown> => ({
  ...Object.fromEntries(
    Object.entries(ApplicantContactSchema.shape).map(([k, v]) => [
      k,
      (v as z.ZodType).safeParse("x").success ? "x" : undefined,
    ])
  ),
  Resume: Buffer.from("x"),
  Answers: {},
  Email: "a@b.co",
  ClickUrl: "https://x.test/a",
  TrackingUrl: "https://x.test/t",
});

const expectAccepts = (block: string): void => {
  const result = compileSchema(block).safeParse(realPayload());
  expect(result.success ? [] : result.error.issues).toEqual([]);
};

describe("emitted applicant contract — canonical keys across every extend-field source", () => {
  it("vocabulary-row names (MobilePhone, AddressLine1) collapse onto ApplicantContactSchema keys", () => {
    const block = payloadBlock(
      emit({
        omitExecuteHttp: true,
        payloadFieldNames: new Set(["MobilePhone", "AddressLine1"]),
      })
    );
    expect(extraKeys(block)).toEqual(EXPECTED_EXTRA_KEYS);
    expectAccepts(block);
  });

  it("form-schema discovered fields collapse onto ApplicantContactSchema keys", () => {
    const { fieldNameMap } = detectFormSchemaFieldNames([formSchemaCapture], FORM_SCHEMA);
    expect(fieldNameMap.get(FIELD_ID)).toBe("AddressLine");
    const block = payloadBlock(
      emit({
        omitExecuteHttp: true,
        discoveredFormFields: new Set(["AddressLine1", "MobilePhone"]),
      })
    );
    expect(extraKeys(block)).toEqual(EXPECTED_EXTRA_KEYS);
    expectAccepts(block);
  });

  it("an HTTP-path flow selected onto ApplicantContactSchema by inputBody evidence collapses the same way", () => {
    const block = payloadBlock(
      emit({
        omitExecuteHttp: false,
        multiStepBody: `    return { data: {} as unknown };`,
        inputBody: { FirstName: "Reginald" },
        payloadFieldNames: new Set(["MobilePhone", "AddressLine1"]),
        discoveredFormFields: new Set(["AddressLine1"]),
      })
    );
    expect(extraKeys(block)).toEqual(EXPECTED_EXTRA_KEYS);
    expectAccepts(block);
  });

  it("flow payload splices use the same keys the contract requires", () => {
    const { code, payloadFieldNames } = emitBrowserFlowTs({
      siteId: "test-site",
      pascal: "TestSite",
      baseUrl: "https://api.example.com",
      flowSteps: FLOW_STEPS,
      isSubmissionFlow: true,
      browserFlowOnly: true,
      vocabulary,
    });
    expect([...payloadFieldNames].sort()).toEqual(["AddressLine", "Phone"]);
    expect(code).toContain("payload.Phone");
    expect(code).toContain("payload.AddressLine");
    expect(code).not.toContain("payload.MobilePhone");
    expect(code).not.toContain("payload.AddressLine1");

    const block = payloadBlock(emit({ omitExecuteHttp: true, payloadFieldNames }));
    expect(extraKeys(block)).toEqual(EXPECTED_EXTRA_KEYS);
    expectAccepts(block);
  });
});
