import { describe, expect, it } from "vitest";
import { z } from "zod";
import { emitContractTs } from "@/scripts/recon-generate";

/**
 * Unit-level regression: emitContractTs must downgrade a merged payload field
 * to `.optional()` when its name matches a declared GraphQL variable that no
 * capture ever populated, while leaving a wired, populated field required.
 * Generic ("catalogSearch") naming, matching
 * recon-generate-declared-filter-unwired-warn.test.ts's fixture convention.
 */

const QUERY =
  "query catalogSearch_Items($nights: String, $visiting: String) { catalogSearch(nights: $nights, visiting: $visiting) { items { id } } }";

function emitSource(unpopulatedDeclaredVariables: readonly string[]): string {
  return emitContractTs({
    siteId: "test-site",
    pascal: "TestSite",
    baseUrl: "https://api.example.com",
    baseHeaders: { "Content-Type": "application/json" },
    minTime: 100,
    safeRps: 10,
    responseBody: { items: [] },
    gql: true,
    gqlQuery: QUERY,
    endpointPath: "/graphql",
    auxFiles: [],
    payloadFieldNames: new Set(["Nights", "Visiting"]),
    unpopulatedDeclaredVariables,
  });
}

/** Extracts the field-declaration line for a given payload field name from the extend block. */
function extractFieldLine(source: string, fieldName: string): string {
  const match = source.match(new RegExp(`\\n\\s*${fieldName}: (z\\.[^\\n]*)`));
  expect(match, `expected a ${fieldName} field in the generated source:\n${source}`).not.toBeNull();
  return match![1]!;
}

/** Builds a runtime zod schema from a single extracted field-declaration expression. */
function buildFieldSchema(expr: string): z.ZodTypeAny {
  const stripped = expr.replace(/,\s*$/, "");
  const build = new Function("z", `return ${stripped};`) as (zod: typeof z) => z.ZodTypeAny;
  return build(z);
}

describe("emitContractTs — unwired declared GraphQL filter variable emits optional payload field", () => {
  it("downgrades the never-populated, name-correlated field to optional while the populated one stays required", () => {
    const source = emitSource(["nights"]);

    const nightsSchema = buildFieldSchema(extractFieldLine(source, "Nights"));
    const visitingSchema = buildFieldSchema(extractFieldLine(source, "Visiting"));

    expect(nightsSchema.safeParse(undefined).success).toBe(true);
    expect(visitingSchema.safeParse(undefined).success).toBe(false);
  });

  it("control: with no unpopulated declared variables, both fields stay required", () => {
    const source = emitSource([]);

    const nightsSchema = buildFieldSchema(extractFieldLine(source, "Nights"));
    const visitingSchema = buildFieldSchema(extractFieldLine(source, "Visiting"));

    expect(nightsSchema.safeParse(undefined).success).toBe(false);
    expect(visitingSchema.safeParse(undefined).success).toBe(false);
  });
});
