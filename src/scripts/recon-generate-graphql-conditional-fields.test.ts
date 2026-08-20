import { describe, expect, it } from "vitest";
import { collectConditionalGraphQLFieldNames, inferZodSchemaFromSamples } from "@/scripts/recon-generate";

describe("inferZodSchemaFromSamples — GraphQL @include/@skip directive fields", () => {
  it("marks a single-sample-present field .optional() when its query selection carries @include", () => {
    const query = `
      query GetOffer($enablePromo: Boolean!) {
        offer {
          basePrice
          discountAmount @include(if: $enablePromo)
        }
      }
    `;
    const sample = { offer: { basePrice: 42, discountAmount: 7 } };

    // Baseline sanity: without directive knowledge, presence-only inference
    // requires the field despite the directive proving it's omittable.
    const presenceOnlySchema = inferZodSchemaFromSamples([sample]);
    expect(presenceOnlySchema).toMatch(/discountAmount: z\.number\(\),/);

    const conditionalFieldNames = collectConditionalGraphQLFieldNames(query);
    const directiveAwareSchema = inferZodSchemaFromSamples([sample], 0, "", { conditionalFieldNames });
    expect(directiveAwareSchema).toMatch(/discountAmount: z\.number\(\)\.optional\(\)/);
  });

  it("keeps a field with no directive and 100% presence required", () => {
    const query = `
      query GetOffer($enablePromo: Boolean!) {
        offer {
          basePrice
          discountAmount @include(if: $enablePromo)
        }
      }
    `;
    const sample = { offer: { basePrice: 42, discountAmount: 7 } };
    const conditionalFieldNames = collectConditionalGraphQLFieldNames(query);
    const directiveAwareSchema = inferZodSchemaFromSamples([sample], 0, "", { conditionalFieldNames });
    expect(directiveAwareSchema).toMatch(/basePrice: z\.number\(\),/);
    expect(directiveAwareSchema).not.toMatch(/basePrice: z\.number\(\)\.optional\(\)/);
  });

  it("collects field names carrying @skip as well as @include, including with arguments", () => {
    const query = `
      query GetOffer($hideTax: Boolean!, $enablePromo: Boolean!) {
        offer {
          taxesAndFeesAmount(currency: "USD") @skip(if: $hideTax)
          discountAmount @include(if: $enablePromo)
        }
      }
    `;
    const names = collectConditionalGraphQLFieldNames(query);
    expect(names.has("taxesAndFeesAmount")).toBe(true);
    expect(names.has("discountAmount")).toBe(true);
  });

  it("matches a directive-conditional field name at any nesting depth it recurs under", () => {
    const query = `
      query GetOffer($enablePromo: Boolean!) {
        lowestPrice {
          discountAmount @include(if: $enablePromo)
        }
        displayPrice {
          discountAmount @include(if: $enablePromo)
        }
      }
    `;
    const samples = [
      {
        lowestPrice: { discountAmount: 7 },
        displayPrice: { discountAmount: 9 },
      },
    ];
    const conditionalFieldNames = collectConditionalGraphQLFieldNames(query);
    const schema = inferZodSchemaFromSamples(samples, 0, "", { conditionalFieldNames });
    const occurrences = schema.match(/discountAmount: z\.number\(\)\.optional\(\)/g) ?? [];
    expect(occurrences.length).toBe(2);
  });

  it("does not mark fields optional when the query has no directives", () => {
    const names = collectConditionalGraphQLFieldNames("query GetOffer { offer { basePrice } }");
    expect(names.size).toBe(0);
  });
});
