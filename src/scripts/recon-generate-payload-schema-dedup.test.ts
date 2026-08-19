import { describe, expect, it } from "vitest";
import { emitContractTs } from "@/scripts/recon-generate";

/**
 * Regression coverage for Defect 4 (cvshealth collision): the spliced
 * payload-schema field set must never re-declare a field ApplicantContactSchema
 * already merges in (or Email, which basePayloadSchemaExpr's own extend
 * already declares), or the generated payload schema shadows an already-typed
 * field with a redundant duplicate key.
 */
describe("emitContractTs — payload schema field dedup against ApplicantContactSchema", () => {
  const inputBody = { FirstName: "Reginald" };

  it("drops fields ApplicantContactSchema/basePayloadSchemaExpr already declare, keeps the genuinely new ones", () => {
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
      inputBody,
      payloadFieldNames: new Set([
        "FirstName",
        "LastName",
        "City",
        "State",
        "PostalCode",
        "Email",
        "MobilePhone",
        "AddressLine1",
      ]),
    });

    const payloadSchemaMatch = source.match(
      /const \w+PayloadSchema = ApplicantContactSchema\.extend\(\{[\s\S]*?\n\}\);/
    );
    expect(payloadSchemaMatch).not.toBeNull();
    const payloadSchemaBlock = payloadSchemaMatch![0]!;

    for (const key of ["FirstName:", "LastName:", "City:", "State:", "PostalCode:"]) {
      expect(payloadSchemaBlock).not.toContain(key);
    }
    expect(payloadSchemaBlock.split("Email:").length - 1).toBe(1);

    expect(payloadSchemaBlock).toContain("MobilePhone: z.string()");
    expect(payloadSchemaBlock).toContain("AddressLine1: z.string()");

    const payloadSchemaExtendCount = (payloadSchemaBlock.match(/\.extend\(\{/g) ?? []).length;
    expect(payloadSchemaExtendCount).toBe(1);
  });

  it("an empty-overlap payloadFieldNames set is unaffected — matches the currently-passing omitExecuteHttp fixture", () => {
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
      inputBody,
      payloadFieldNames: new Set(["MobilePhone"]),
    });

    expect(source).toContain("MobilePhone: z.string()");
    expect(source).toContain(
      "ApplicantContactSchema.extend({\n  Email: z.email(),\n  ClickUrl: z.string().min(1),\n  Answers: multipartJsonObject(z.record(z.string(), z.unknown())),\n  MobilePhone: z.string(),\n})"
    );
  });
});
