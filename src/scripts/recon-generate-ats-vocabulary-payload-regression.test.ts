import { describe, expect, it } from "vitest";
import type { ReconFormSchema } from "@/recon/form-schema";
import { detectFormSchemaFieldNames, emitContractTs } from "@/scripts/recon-generate";

/**
 * End-to-end regression for the reported defect: recon-generate's real
 * detectFormSchemaFieldNames -> emitContractTs pipeline must not mint an
 * ATS-label-named duplicate of a field ApplicantContactSchema already
 * declares. Uses a generic ("Mobile Phone") label so no plugin or site is
 * referenced.
 */

const UUID_A = "11111111-1111-1111-1111-111111111111";

const capture = (responseBody: unknown) => ({
  timestamp: "2024-01-01T00:00:00Z",
  phase: "action" as const,
  method: "GET",
  url: "https://example.com/schema",
  status: 200,
  requestHeaders: {},
  requestPostData: null,
  responseHeaders: {},
  responseBody,
  operationName: null,
  query: null,
  variables: null,
  decodedParams: null,
});

/** The wire format the engine used to hardcode, now supplied as data. */
const HISTORICAL: ReconFormSchema = {
  fieldIdKey: "FieldId",
  fieldNameKeys: ["FieldSourceCode", "FieldName"],
  fieldOptionsKey: "FieldOptions",
  optionIdKey: "Id",
  optionValueKey: "Value",
  responseValueKey: "Value",
  responseOptionIdKey: "OptionId",
};

describe("recon-generate — ATS-vocabulary payload-schema regression (detectFormSchemaFieldNames -> emitContractTs)", () => {
  it("never re-declares a field ApplicantContactSchema already supplies once its ATS label is discovered", () => {
    const body = [{ FieldId: UUID_A, FieldName: "Mobile Phone" }];
    const { fieldNameMap } = detectFormSchemaFieldNames([capture(body)], HISTORICAL);

    const source = emitContractTs({
      siteId: "test-site",
      pascal: "TestSite",
      baseUrl: "https://api.example.com",
      baseHeaders: { "Content-Type": "application/json" },
      minTime: 100,
      safeRps: 10,
      responseBody: { saved: true },
      gql: false,
      gqlQuery: null,
      endpointPath: "/apply/create",
      auxFiles: [],
      multiStepBody: undefined,
      inputBody: { FirstName: "Reginald" },
      discoveredFormFields: new Set(fieldNameMap.values()),
    });

    const payloadSchemaMatch = source.match(
      /const \w+PayloadSchema = ApplicantContactSchema\.extend\(\{[\s\S]*?\n\}\);/
    );
    expect(payloadSchemaMatch).not.toBeNull();
    const payloadSchemaBlock = payloadSchemaMatch![0]!;

    expect(payloadSchemaBlock).not.toContain("MobilePhone:");
    expect(payloadSchemaBlock).not.toContain("Phone: z.string()");

    const payloadSchemaExtendCount = (payloadSchemaBlock.match(/\.extend\(\{/g) ?? []).length;
    expect(payloadSchemaExtendCount).toBe(1);
  });
});
