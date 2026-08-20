import { describe, expect, it } from "vitest";
import type { ReconFormSchema } from "@/recon/form-schema";
import { detectFormSchemaFieldNames } from "@/scripts/recon-generate";

const UUID_A = "11111111-1111-1111-1111-111111111111";
const UUID_B = "22222222-2222-2222-2222-222222222222";

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

const VENDOR: ReconFormSchema = {
  fieldIdKey: "FieldId",
  fieldNameKeys: ["FieldSourceCode", "FieldName"],
  fieldOptionsKey: "FieldOptions",
  optionIdKey: "Id",
  optionValueKey: "Value",
  responseValueKey: "Value",
  responseOptionIdKey: "OptionId",
};

describe("detectFormSchemaFieldNames — form-schema label canonicalization against the shared field vocabulary", () => {
  it("maps a top-level 'Address Line 1' label to the canonical 'AddressLine', not a fresh 'AddressLine1'", () => {
    const body = [{ FieldId: UUID_A, FieldName: "Address Line 1" }];
    const { fieldNameMap } = detectFormSchemaFieldNames([capture(body)], VENDOR);
    expect(fieldNameMap.get(UUID_A)).toBe("AddressLine");
  });

  it("maps a top-level 'Mobile Phone' label to the canonical 'Phone', not a fresh 'MobilePhone'", () => {
    const body = [{ FieldId: UUID_A, FieldName: "Mobile Phone" }];
    const { fieldNameMap } = detectFormSchemaFieldNames([capture(body)], VENDOR);
    expect(fieldNameMap.get(UUID_A)).toBe("Phone");
  });

  it("does NOT collapse a repeated-section instance of the same label into the base field", () => {
    const body = [
      { FieldId: UUID_A, FieldName: "REFERENCE #1" },
      { FieldId: UUID_B, FieldName: "First Name" },
    ];
    const { fieldNameMap } = detectFormSchemaFieldNames([capture(body)], VENDOR);
    expect(fieldNameMap.get(UUID_A)).toBeUndefined();
    expect(fieldNameMap.get(UUID_B)).toBe("Reference1FirstName");
  });
});
