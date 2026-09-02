import { describe, expect, it } from "vitest";

import { emitContractTs, type FoldReturnSpec } from "@/scripts/recon-generate";

/** Minimal opts that satisfy the emitter for a non-multipart, non-GraphQL
 * plugin. Matches BASE_OPTS in recon-generate-bind-literal.test.ts — kept
 * separate per that file's own fixture rather than imported. */
const BASE_OPTS = {
  siteId: "test-site",
  pascal: "TestSite",
  baseUrl: "https://example.com",
  baseHeaders: { "Content-Type": "application/json" },
  minTime: 100,
  safeRps: 10,
  responseBody: { id: "abc", active: true },
  gql: false,
  gqlQuery: null,
  endpointPath: "/api/search",
  auxFiles: [],
};

/**
 * Pins the feat-005 fix: a declared `foldReturn.drillParamBindings` entry
 * becomes a typed, defaulted, optional field on the emitted PayloadSchema —
 * see docs/recon-generate-foldreturn-cannot-bind-drill-query-param-to-caller-
 * payload.md. Omitting the field on a caller request preserves today's
 * frozen-literal drill behavior; supplying it lets the caller drive the
 * drill request.
 */
describe("emitContractTs — drillParamBindings payload-schema emission", () => {
  it("emits an int-typed binding as a coerced, optional, defaulted number field", () => {
    const foldReturnSpec: FoldReturnSpec = {
      endpointPattern: "/api/drill",
      resultsPath: "items",
      joinFields: ["id"],
      drillParamBindings: {
        adults: { payloadField: "adults", type: "int", default: 2 },
      },
    };

    const contract = emitContractTs({ ...BASE_OPTS, foldReturnSpec });

    expect(contract).toContain("adults: z.coerce.number().int().optional().default(2),");
  });

  it("emits a string-typed binding as an optional, defaulted string field", () => {
    const foldReturnSpec: FoldReturnSpec = {
      endpointPattern: "/api/drill",
      resultsPath: "items",
      joinFields: ["id"],
      drillParamBindings: {
        region: { payloadField: "region", type: "string", default: "us" },
      },
    };

    const contract = emitContractTs({ ...BASE_OPTS, foldReturnSpec });

    expect(contract).toContain('region: z.string().optional().default("us"),');
  });

  it("emits a boolean-typed binding as a coerced, optional, defaulted boolean field", () => {
    const foldReturnSpec: FoldReturnSpec = {
      endpointPattern: "/api/drill",
      resultsPath: "items",
      joinFields: ["id"],
      drillParamBindings: {
        includeTax: { payloadField: "includeTax", type: "boolean", default: false },
      },
    };

    const contract = emitContractTs({ ...BASE_OPTS, foldReturnSpec });

    expect(contract).toContain("includeTax: z.coerce.boolean().optional().default(false),");
  });

  it("skips a binding whose payloadField collides with an ApplicantContactSchema reserved name", () => {
    const foldReturnSpec: FoldReturnSpec = {
      endpointPattern: "/api/drill",
      resultsPath: "items",
      joinFields: ["id"],
      drillParamBindings: {
        firstName: { payloadField: "FirstName", type: "string", default: "Jo" },
      },
    };

    const contract = emitContractTs({
      ...BASE_OPTS,
      inputBody: { FirstName: "Reginald" },
      foldReturnSpec,
    });

    expect(contract).not.toContain('FirstName: z.string().optional().default("Jo"),');
  });

  it("emits nothing when no foldReturnSpec is declared", () => {
    const withNone = emitContractTs({ ...BASE_OPTS, foldReturnSpec: null });
    const withOmitted = emitContractTs({ ...BASE_OPTS });

    expect(withNone).toEqual(withOmitted);
    expect(withNone).not.toContain("adults");
  });
});
