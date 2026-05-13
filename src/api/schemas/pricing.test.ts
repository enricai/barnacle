import { describe, expect, it } from "vitest";
import type { ZodTypeAny } from "zod";

import { categoryPricingResponseSchema } from "@/api/schemas/category-pricing";
import { groupPricingResponseSchema } from "@/api/schemas/group-pricing";
import { superCategoryPricingResponseSchema } from "@/api/schemas/super-category-pricing";
import { loadVpsFixture, type VpsFixtureKey } from "../../../test/helpers/vps-fixtures";

interface Case {
  key: VpsFixtureKey;
  schema: ZodTypeAny;
}

const cases: Case[] = [
  { key: "super-category-pricing", schema: superCategoryPricingResponseSchema },
  { key: "category-pricing", schema: categoryPricingResponseSchema },
  { key: "group-pricing", schema: groupPricingResponseSchema },
];

describe("pricing response schemas round-trip RC fixtures", () => {
  it.each(cases)("parses every response in the $key fixture", ({ key, schema }) => {
    const { responses } = loadVpsFixture(key);
    expect(responses.length).toBeGreaterThan(0);
    for (const response of responses) {
      const parsed = schema.safeParse(response);
      if (!parsed.success) {
        throw new Error(
          `${key} fixture failed to parse:\n${parsed.error.issues
            .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
            .join("\n")}`
        );
      }
    }
  });
});
