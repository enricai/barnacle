import { loadVpsFixture, type VpsFixtureKey } from "@test/helpers/vps-fixtures";
import { describe, expect, it } from "vitest";
import type { ZodTypeAny } from "zod";
import { priceChangesCategoryResponseSchema } from "@/api/schemas/price-changes-category";
import { priceChangeRequestSchema } from "@/api/schemas/price-changes-common";
import { priceChangesSuperCategoryResponseSchema } from "@/api/schemas/price-changes-super-category";
import { promotionDetailsResponseSchema } from "@/api/schemas/promotion-details";
import { sailingPackageChangesResponseSchema } from "@/api/schemas/sailing-package-changes";

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

describe("priceChangeRequestSchema fromDateTime validation", () => {
  const base = { client: { agencyId: "A1", currencyCodes: ["USD"] } };

  it("accepts a valid ISO-8601 timestamp", () => {
    const parsed = priceChangeRequestSchema.safeParse({
      ...base,
      fromDateTime: "2024-01-01T00:00:00Z",
    });
    expect(parsed.success).toBe(true);
  });

  it("accepts an ISO-8601 timestamp with fractional seconds", () => {
    const parsed = priceChangeRequestSchema.safeParse({
      ...base,
      fromDateTime: "2024-01-01T00:00:00.123Z",
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects a 10-char garbage string (previously accepted by .min(10))", () => {
    // Before the parseISO+isValid guard, this would have slipped through
    // validation and produced Invalid Date in services/price-changes.ts,
    // which Prisma's `capturedAt: { gt: <Invalid Date> }` handles
    // inconsistently — some driver versions coerce to null and return
    // the entire table.
    const parsed = priceChangeRequestSchema.safeParse({
      ...base,
      fromDateTime: "xxxxxxxxxx",
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects a string shorter than 10 characters", () => {
    const parsed = priceChangeRequestSchema.safeParse({
      ...base,
      fromDateTime: "2024",
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects a malformed datetime with the right shape but wrong values", () => {
    // Month 13, hour 25 — looks like an ISO datetime but parseISO returns Invalid Date.
    const parsed = priceChangeRequestSchema.safeParse({
      ...base,
      fromDateTime: "2024-13-40T25:00:00Z",
    });
    expect(parsed.success).toBe(false);
  });
});
