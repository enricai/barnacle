import { describe, expect, it } from "vitest";
import { emitContractTs } from "@/scripts/recon-generate";

const BASE_OPTS = {
  siteId: "test-site",
  pascal: "TestSite",
  baseUrl: "https://example.com",
  baseHeaders: {},
  minTime: 100,
  safeRps: 10,
  responseBody: { ok: true },
  gql: false,
  gqlQuery: null,
  endpointPath: "/api/example",
  auxFiles: [],
  multiStepBody: 'const b = `${JSON.stringify({ c: payload.items["0"]!.criteria })}`;',
};

function itemsDeclaration(extra: object): string {
  const contract = emitContractTs({ ...BASE_OPTS, ...extra } as never);
  return contract.split("\n").find((line) => line.startsWith("  items:")) ?? "";
}

describe("emitContractTs — accessor-derived shape is the single schema decision", () => {
  it("declares an indexed field as array-of-object over a declared scalar payload field", () => {
    const decl = itemsDeclaration({ payloadFieldNames: new Set(["items"]) });
    expect(decl).toContain("z.array(z.object({ criteria: z.string() }))");
  });

  it("declares it structured over discovered-form, additional-body and drill-binding scalars", () => {
    const decl = itemsDeclaration({
      discoveredFormFields: new Set(["items"]),
      discoveredAdditionalBodyKeys: new Map([["items", { kind: "string" }]]),
    });
    expect(decl).toContain("z.array(z.object({ criteria: z.string() }))");
  });

  it("replaces a structured declaration that lacks the dereferenced key", () => {
    const decl = itemsDeclaration({
      discoveredStructuredKeys: new Map([["items", "z.array(z.string())"]]),
    });
    expect(decl).toContain("z.array(z.object({ criteria: z.string() }))");
  });

  it("keeps a richer structured declaration that already covers the accessed key", () => {
    const decl = itemsDeclaration({
      discoveredStructuredKeys: new Map([
        ["items", "z.array(z.object({ criteria: z.string(), order: z.string() }))"],
      ]),
    });
    expect(decl).toContain("order: z.string()");
  });

  it("does not let a value constraint replace an accessor-derived array", () => {
    const decl = itemsDeclaration({
      payloadFieldNames: new Set(["items"]),
      valueConstraints: { items: { min: 1 } },
    });
    expect(decl).toContain("z.array(");
  });
});
