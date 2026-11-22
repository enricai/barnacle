import { describe, expect, it } from "vitest";
import { unreferencedRequiredUrlFields } from "@/scripts/recon-generate";

const RESPONSE = `const SearchResponseSchema = z.object({
  results: z.object({
    items: z.array(z.object({
      imageUrl: z.string(),
    })),
  }),
});
`;

const payloadSchema = (fields: string) =>
  `const SearchPayloadSchema = z.object({\n${fields}\n});\n`;

describe("unreferencedRequiredUrlFields scans the payload schema only", () => {
  it("ignores a required response-schema *Url field", () => {
    const code = payloadSchema("  qty: z.string(),") + RESPONSE;

    expect(unreferencedRequiredUrlFields(code, "")).toEqual([]);
  });

  it("reports a required payload *Url field that nothing reads", () => {
    const code = payloadSchema("  returnUrl: z.string(),") + RESPONSE;

    expect(unreferencedRequiredUrlFields(code, "")).toEqual(["returnUrl"]);
  });

  it("reports only the payload field when both schemas declare a required *Url", () => {
    const code = RESPONSE + payloadSchema("  returnUrl: z.string(),");

    expect(unreferencedRequiredUrlFields(code, "")).toEqual(["returnUrl"]);
  });

  it("stops reporting the payload field once it is read", () => {
    const code = `${payloadSchema("  returnUrl: z.string(),")}${RESPONSE}go(payload.returnUrl);`;

    expect(unreferencedRequiredUrlFields(code, "")).toEqual([]);
  });
});
