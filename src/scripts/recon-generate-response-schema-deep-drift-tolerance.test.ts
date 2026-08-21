import { describe, expect, it } from "vitest";
import { z } from "zod/v4";

import { inferZodSchemaFromSamples } from "@/scripts/recon-generate";

/**
 * Structural coverage for the deep-drift-tolerance fix: a schema built from
 * multiple same-operation captures must still `safeParse` a live payload
 * where a nested leaf field was renamed, dropped, or gained a neighbor the
 * captures never showed — while a top-level identity field that every
 * capture always returned still gates validation. The generated expression
 * is evaluated against a real `z` import rather than string-matched, since
 * the reported failure is a runtime `safeParse` rejection, not a shape typo.
 */
describe("inferZodSchemaFromSamples — deep nested subtrees tolerate live drift", () => {
  const buildSchema = (samples: readonly unknown[]): z.ZodTypeAny => {
    const expr = inferZodSchemaFromSamples(samples, 0, "", { looseServerResponse: true });
    return new Function("z", `return (${expr});`)(z) as z.ZodTypeAny;
  };

  // Two captures of the same read operation, three levels below the root
  // (data.catalogSearch.results.items[].badges[]), where the deepest object
  // drifts between captures: "label" becomes "text", "color" disappears,
  // and "icon" appears for the first time.
  const captureOne = {
    requestId: "req-1",
    data: {
      catalogSearch: {
        results: {
          items: [{ id: "item-1", badges: [{ label: "sale", color: "red" }] }],
        },
      },
    },
  };
  const captureTwo = {
    requestId: "req-2",
    data: {
      catalogSearch: {
        results: {
          items: [{ id: "item-2", badges: [{ text: "clearance", icon: "tag" }] }],
        },
      },
    },
  };

  it("accepts a live payload with a renamed nested leaf, a dropped nested leaf, and an unseen extra nested field", () => {
    const schema = buildSchema([captureOne, captureTwo]);
    const livePayload = {
      requestId: "req-live",
      data: {
        catalogSearch: {
          results: {
            items: [
              {
                id: "item-live",
                // "label"/"color" are entirely absent here (drifted away),
                // "text" is present under a name distinct from "label", and
                // "tag" was never observed in either capture at all.
                badges: [{ text: "final markdown", tag: "urgent" }],
              },
            ],
          },
        },
      },
    };
    const result = schema.safeParse(livePayload);
    expect(result.success).toBe(true);
  });

  it("still rejects a live payload missing the top-level identity field every capture returned", () => {
    const schema = buildSchema([captureOne, captureTwo]);
    const livePayloadMissingIdentity = {
      data: {
        catalogSearch: {
          results: {
            items: [{ id: "item-live", badges: [{ text: "final markdown", tag: "urgent" }] }],
          },
        },
      },
    };
    const result = schema.safeParse(livePayloadMissingIdentity);
    expect(result.success).toBe(false);
  });
});
