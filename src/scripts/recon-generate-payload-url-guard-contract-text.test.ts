import { describe, expect, it } from "vitest";
import {
  assertRequiredUrlFieldsReferenced,
  type PayloadSchemaParts,
  unreadRelaxedResponseUrlFields,
  unreferencedRequiredUrlFields,
} from "./recon-generate.js";

const parts = (...fields: Array<[string, boolean]>): PayloadSchemaParts => ({
  expr: "z.object({})",
  fields: fields.map(([name, optional]) => ({ name, optional })),
});
const response = `const ExampleResponseSchema = z.object({\n  data: z.object({\n    mapUrl: z.string(),\n  }),\n});\n`;
const payloadDecl = (p: PayloadSchemaParts) => `const ExamplePayloadSchema = ${p.expr};\n`;

describe("required-URL guard on the emitter's payload field data", () => {
  it("ignores a required response *Url leaf declared after the payload schema", () => {
    const p = parts(["q", false]);
    const code = payloadDecl(p) + response;
    expect(unreferencedRequiredUrlFields(code, "", p)).toEqual([]);
    expect(() => assertRequiredUrlFieldsReferenced(code, "", p)).not.toThrow();
  });

  it("ignores a response *Url leaf when the response schema precedes the payload schema", () => {
    const p = parts(["q", false]);
    expect(unreferencedRequiredUrlFields(response + payloadDecl(p), "", p)).toEqual([]);
  });

  it("reports nothing when there are no payload fields (no payload declaration)", () => {
    expect(unreferencedRequiredUrlFields(response, "", { expr: "", fields: [] })).toEqual([]);
  });

  it("reports only the payload's own unread required *Url field", () => {
    const p = parts(["siteUrl", false]);
    const code = payloadDecl(p) + response;
    expect(unreferencedRequiredUrlFields(code, "", p)).toEqual(["siteUrl"]);
    expect(() => assertRequiredUrlFieldsReferenced(code, "", p)).toThrow(/siteUrl/);
  });

  it("does not flag an optional or a read payload *Url field", () => {
    expect(unreferencedRequiredUrlFields(response, "", parts(["siteUrl", true]))).toEqual([]);
    expect(
      unreferencedRequiredUrlFields(response, "fetch(payload.siteUrl)", parts(["siteUrl", false]))
    ).toEqual([]);
  });

  it("attributes only response-side relaxed *Url leaves", () => {
    const p: PayloadSchemaParts = {
      expr: "z.object({\n  logoUrl: z.string().nullable().optional(),\n})",
      fields: [{ name: "logoUrl", optional: true }],
    };
    const relaxed = `const ExampleResponseSchema = z.object({\n  logoUrl: z.string().nullable().optional(),\n});\n`;
    const code = `const ExamplePayloadSchema = ${p.expr};\n${relaxed}`;
    expect(unreadRelaxedResponseUrlFields(code, "", p)).toEqual(["logoUrl"]);
    expect(unreadRelaxedResponseUrlFields(`const P = ${p.expr};\n`, "", p)).toEqual([]);
  });
});
