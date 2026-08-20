import { describe, expect, it } from "vitest";
import {
  collectConditionalGraphQLFieldNames,
  inferZodSchemaFromSamples,
} from "@/scripts/recon-generate";

describe("directive-guarded GraphQL fields infer as optional from query text, not sample presence", () => {
  it("types an @include-guarded nested field .optional() even though it's present in the one sample", () => {
    const query = `
      query GetWidget($showTax: Boolean!) {
        widget {
          basePrice
          taxAmount @include(if: $showTax)
        }
      }
    `;
    const sample = { widget: { basePrice: 10, taxAmount: 2 } };
    const conditionalFieldNames = collectConditionalGraphQLFieldNames(query);

    const schema = inferZodSchemaFromSamples([sample], 0, "", { conditionalFieldNames });

    expect(schema).toMatch(/taxAmount: z\.number\(\)\.optional\(\)/);
  });

  it("types an @skip-guarded field .optional() the same way as @include", () => {
    const query = `
      query GetWidget($hideSurcharge: Boolean!) {
        widget {
          basePrice
          surcharge @skip(if: $hideSurcharge)
        }
      }
    `;
    const sample = { widget: { basePrice: 10, surcharge: 3 } };
    const conditionalFieldNames = collectConditionalGraphQLFieldNames(query);

    const schema = inferZodSchemaFromSamples([sample], 0, "", { conditionalFieldNames });

    expect(schema).toMatch(/surcharge: z\.number\(\)\.optional\(\)/);
  });

  it("keeps a structurally identical, undirected sibling field required (regression guard)", () => {
    const query = `
      query GetWidget($showTax: Boolean!) {
        widget {
          basePrice
          taxAmount @include(if: $showTax)
        }
      }
    `;
    const sample = { widget: { basePrice: 10, taxAmount: 2 } };
    const conditionalFieldNames = collectConditionalGraphQLFieldNames(query);

    const schema = inferZodSchemaFromSamples([sample], 0, "", { conditionalFieldNames });

    expect(schema).toMatch(/basePrice: z\.number\(\),/);
    expect(schema).not.toMatch(/basePrice: z\.number\(\)\.optional\(\)/);
  });

  it("still marks a field optional when the directive's controlling variable is a hardcoded true literal in the emitted call", () => {
    // Mirrors the reported defect: the recon flow may hardcode `showTax: true`
    // when emitting the call, but the schema must remain correct even if that
    // literal is later parameterized or the server's own default flips — so
    // optionality is derived from the directive existing in the query text,
    // never from what value the call happens to pass.
    const query = `
      query GetWidget {
        widget {
          basePrice
          taxAmount @include(if: true)
        }
      }
    `;
    const sample = { widget: { basePrice: 10, taxAmount: 2 } };
    const conditionalFieldNames = collectConditionalGraphQLFieldNames(query);

    const schema = inferZodSchemaFromSamples([sample], 0, "", { conditionalFieldNames });

    expect(schema).toMatch(/taxAmount: z\.number\(\)\.optional\(\)/);
  });

  it("proves presence-only inference (no directive knowledge) would wrongly require the guarded field", () => {
    const query = `
      query GetWidget($showTax: Boolean!) {
        widget {
          basePrice
          taxAmount @include(if: $showTax)
        }
      }
    `;
    const sample = { widget: { basePrice: 10, taxAmount: 2 } };

    const presenceOnlySchema = inferZodSchemaFromSamples([sample]);

    expect(presenceOnlySchema).toMatch(/taxAmount: z\.number\(\),/);
    expect(presenceOnlySchema).not.toMatch(/taxAmount: z\.number\(\)\.optional\(\)/);

    // Only once the query text is parsed does the same sample yield .optional().
    const conditionalFieldNames = collectConditionalGraphQLFieldNames(query);
    const directiveAwareSchema = inferZodSchemaFromSamples([sample], 0, "", {
      conditionalFieldNames,
    });
    expect(directiveAwareSchema).toMatch(/taxAmount: z\.number\(\)\.optional\(\)/);
  });
});
