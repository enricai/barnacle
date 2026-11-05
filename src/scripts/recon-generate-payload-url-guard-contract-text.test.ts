import { describe, expect, it } from "vitest";
import {
  assertRequiredUrlFieldsReferenced,
  unreadRelaxedResponseUrlFields,
  unreferencedRequiredUrlFields,
} from "./recon-generate.js";

const payload = (fields: string) =>
  `const ExamplePayloadSchema = z.object({\n${fields}\n});\n`;
const response = `const ExampleResponseSchema = z.object({\n  data: z.object({\n    mapUrl: z.string(),\n  }),\n});\n`;

describe("required-URL guard on contract text alone", () => {
  it("ignores a required response *Url leaf declared after the payload schema", () => {
    const code = payload("  q: z.string(),") + response;
    expect(unreferencedRequiredUrlFields(code, "")).toEqual([]);
    expect(() => assertRequiredUrlFieldsReferenced(code, "")).not.toThrow();
  });

  it("ignores a response *Url leaf when the response schema precedes the payload schema", () => {
    const code = response + payload("  q: z.string(),");
    expect(unreferencedRequiredUrlFields(code, "")).toEqual([]);
  });

  it("ignores a response *Url leaf when the payload schema is exported", () => {
    const code = `export ${payload("  q: z.string(),")}${response}`;
    expect(unreferencedRequiredUrlFields(code, "")).toEqual([]);
  });

  it("reports only the payload's own unread required *Url field", () => {
    const code = `export ${payload("  siteUrl: z.string(),")}${response}`;
    expect(unreferencedRequiredUrlFields(code, "")).toEqual(["siteUrl"]);
    expect(() => assertRequiredUrlFieldsReferenced(code, "")).toThrow(
      /siteUrl/,
    );
  });

  it("does not flag an optional or a read payload *Url field", () => {
    expect(
      unreferencedRequiredUrlFields(
        payload("  siteUrl: z.string().optional(),") + response,
        "",
      ),
    ).toEqual([]);
    expect(
      unreferencedRequiredUrlFields(
        payload("  siteUrl: z.string(),") + response,
        "fetch(payload.siteUrl)",
      ),
    ).toEqual([]);
  });

  it("does not let a payload schema containing a string with brackets move the boundary", () => {
    const code =
      payload(
        '  q: z.string().describe("a ; ) } b"),\n  siteUrl: z.string(),',
      ) + response;
    expect(unreferencedRequiredUrlFields(code, "")).toEqual(["siteUrl"]);
  });

  it("attributes only response-side relaxed *Url leaves", () => {
    const relaxed = `const ExampleResponseSchema = z.object({\n  logoUrl: z.string().nullable().optional(),\n});\n`;
    const code =
      payload("  logoUrl: z.string().nullable().optional(),") + relaxed;
    expect(unreadRelaxedResponseUrlFields(code, "")).toEqual(["logoUrl"]);
    expect(
      unreadRelaxedResponseUrlFields(payload("  q: z.string(),"), ""),
    ).toEqual([]);
  });
});
