import { describe, expect, it } from "vitest";
import { z } from "zod/v4";

import { emitContractTs } from "@/scripts/recon-generate";

/**
 * Regression guard for the filed report: `recon:generate` emitted a
 * verbatim, all-required response schema whose presentational leaves and
 * `__typename` machinery caused any live drift to reject a valid 200 and
 * force a browser fallback. This reproduces the report's acceptance
 * scenario end-to-end through the real `emitContractTs` emitter (not the
 * inference helper in isolation): a deeply nested GraphQL-shaped catalog
 * response with presentational leaves and `__typename`, the emitted
 * `<Pascal>ResponseSchema` extracted and eval'd, then safeParse'd against a
 * live-drifted variant (a presentational field renamed, `__typename`
 * dropped, and a wholly new nested field added).
 */

function extractResponseSchemaExpr(contract: string, pascal: string): string {
  const match = contract.match(
    new RegExp(`^export const ${pascal}ResponseSchema = ([\\s\\S]+?);\\n\\nexport type `, "m")
  );
  if (!match?.[1]) throw new Error(`no ResponseSchema declaration found in contract:\n${contract}`);
  return match[1];
}

describe("emitContractTs — generated ResponseSchema survives live drift end-to-end (widget-catalog scenario)", () => {
  const capturedResponseBody = {
    data: {
      catalogSearch: {
        results: {
          widgets: [
            {
              id: "widget-1",
              badges: [
                {
                  backgroundColor: "#fff",
                  borderColor: "#000",
                  textColor: "#111",
                  shape: "rounded",
                  __typename: "Badge",
                },
              ],
              __typename: "Widget",
            },
          ],
          __typename: "WidgetResults",
        },
        __typename: "CatalogSearch",
      },
    },
  };

  // A second same-operation capture where the presentational badge leaves
  // aren't all present -- gatherResponseBodySamples feeds every same-identity
  // capture into inferZodSchemaFromSamples, which folds presence across
  // samples into `.optional()`. This is what a hand-trimmed schema captures
  // by naming only the load-bearing keys; the generator now infers the same
  // looseness from the evidence recon already collects.
  const secondCapture = {
    data: {
      catalogSearch: {
        results: {
          widgets: [
            {
              id: "widget-2",
              badges: [{ shape: "square" }],
              __typename: "Widget",
            },
          ],
          __typename: "WidgetResults",
        },
        __typename: "CatalogSearch",
      },
    },
  };

  const contract = emitContractTs({
    siteId: "widget-catalog",
    pascal: "WidgetCatalog",
    baseUrl: "https://example.com",
    baseHeaders: { "Content-Type": "application/json" },
    minTime: 100,
    safeRps: 10,
    responseBody: capturedResponseBody,
    responseBodySamples: [capturedResponseBody, secondCapture],
    gql: true,
    gqlQuery: "query catalogSearch { catalogSearch { results { widgets { id } } } }",
    endpointPath: "/graphql",
    auxFiles: [],
  });

  const schemaExpr = extractResponseSchemaExpr(contract, "WidgetCatalog");
  const responseSchema = new Function("z", `return (${schemaExpr});`)(z) as z.ZodTypeAny;

  it("does not require __typename anywhere in the generated schema source", () => {
    expect(contract).not.toContain("__typename: z.string()");
  });

  it("accepts the exact captured response", () => {
    expect(responseSchema.safeParse(capturedResponseBody).success).toBe(true);
  });

  it("still validates a live response with a presentational field renamed, __typename dropped, and a new field added", () => {
    const liveDriftedResponseBody = {
      data: {
        catalogSearch: {
          results: {
            widgets: [
              {
                id: "widget-1",
                badges: [
                  {
                    // backgroundColor renamed to bgColor -- presentational drift.
                    bgColor: "#fff",
                    borderColor: "#000",
                    textColor: "#111",
                    shape: "rounded",
                    // __typename dropped entirely.
                  },
                ],
                // Wholly new nested field the capture never saw.
                availability: { inStock: true, restockDate: null },
              },
            ],
          },
        },
      },
    };

    const result = responseSchema.safeParse(liveDriftedResponseBody);
    expect(result.success).toBe(true);
  });
});
