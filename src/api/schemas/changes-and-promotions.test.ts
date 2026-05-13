import { describe, expect, it } from "vitest";
import type { ZodTypeAny } from "zod";

import { priceChangesCategoryResponseSchema } from "@/api/schemas/price-changes-category";
import { priceChangesSuperCategoryResponseSchema } from "@/api/schemas/price-changes-super-category";
import { promotionDetailsResponseSchema } from "@/api/schemas/promotion-details";
import { sailingPackageChangesResponseSchema } from "@/api/schemas/sailing-package-changes";
import { loadVpsFixture, type VpsFixtureKey } from "../../../test/helpers/vps-fixtures";

interface Case {
  key: VpsFixtureKey;
  schema: ZodTypeAny;
}

const cases: Case[] = [
  { key: "sailing-package-changes", schema: sailingPackageChangesResponseSchema },
  { key: "price-changes-super-category", schema: priceChangesSuperCategoryResponseSchema },
  { key: "price-changes-category", schema: priceChangesCategoryResponseSchema },
  { key: "promotion-details", schema: promotionDetailsResponseSchema },
];

describe("delta + promotion response schemas round-trip RC fixtures", () => {
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
