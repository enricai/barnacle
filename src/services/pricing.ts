import { parseISO } from "date-fns";

import { successEnvelope } from "@/api/helpers/envelope";
import type { CategoryPricingResponse } from "@/api/schemas/category-pricing";
import type { GroupPricingResponse } from "@/api/schemas/group-pricing";
import type { PricingRequestBase } from "@/api/schemas/pricing-common";
import type { SuperCategoryPricingResponse } from "@/api/schemas/super-category-pricing";
import { getCachedResponse, setCachedResponse } from "@/cache/response-cache";
import { type PricingScrapeResult, scrapeSailingPricing } from "@/scraper/flows/pricing";
import { runWithSession } from "@/scraper/pool";
import { savePricingSnapshot } from "@/snapshots/store";

/**
 * Maps a scraped cabin row into the generic `bestRate` shape used across
 * all three pricing response variants. We only hold the fields we can
 * observe from the public UI — the rest are left absent and Zod's
 * passthrough tolerates that downstream.
 */
function cabinToBestRate(c: PricingScrapeResult[number]) {
  return {
    stateroomCategoryCode: c.stateroomCategoryCode,
    stateroomSuperCategory: c.stateroomSuperCategory,
    stateroomTypeCode: c.stateroomTypeCode,
    accessibleStateroomExistFlag: c.accessibleStateroomExistFlag,
    refundableFareFlag: c.refundableFareFlag,
    leadPromotion: c.leadPromotionShortDescription
      ? {
          promotionId: c.leadPromotionShortDescription,
          shortDescription: c.leadPromotionShortDescription,
        }
      : undefined,
    averagePerGuestPricePoint: {
      netTotal: c.pricePerGuest,
      netCruiseFareAmount: c.netCruiseFareAmount,
      taxesAndFeesAmount: c.taxesAndFeesAmount,
      originalAmount: c.originalAmount,
      includedInNetTotal: ["CFARE", "NCCF"],
    },
  };
}

async function scrapeAndPersist(
  request: PricingRequestBase,
  granularity: "super-category" | "category" | "group"
): Promise<PricingScrapeResult> {
  const cabins = await runWithSession((session) =>
    scrapeSailingPricing(session, {
      brandCode: request.brandCode,
      shipCode: request.shipCode,
      sailDate: request.sailDate,
      packageCode: request.packageCode,
      occupancy: request.occupancy,
      currencyCode: request.currencyCode,
      bookingTypeCode: request.bookingTypeCode,
    })
  );

  await savePricingSnapshot(
    {
      brandCode: request.brandCode,
      shipCode: request.shipCode,
      sailDate: parseISO(request.sailDate),
      packageCode: request.packageCode,
      currencyCode: request.currencyCode,
      occupancy: request.occupancy,
      bookingTypeCode: request.bookingTypeCode,
      granularity,
    },
    cabins
  );

  return cabins;
}

/**
 * Groups cabin rows by their super-category (I/O/B/D/A/C) and returns a
 * single `promotionBestPrices[]` entry with the observed lead promotion.
 */
export async function getSuperCategoryPricing(
  request: PricingRequestBase
): Promise<SuperCategoryPricingResponse> {
  const endpoint = "/v1/partner-pricing/super-category-pricing";
  const cached = getCachedResponse<SuperCategoryPricingResponse>(endpoint, request);
  if (cached.value) return cached.value;

  const cabins = await scrapeAndPersist(request, "super-category");

  const bySuper = new Map<string, PricingScrapeResult>();
  for (const c of cabins) {
    const key = c.stateroomSuperCategory ?? "UNK";
    const bucket = bySuper.get(key) ?? [];
    bucket.push(c);
    bySuper.set(key, bucket);
  }

  const superCategoryBestPrices = Array.from(bySuper.entries()).map(([code, rows]) => {
    const seed = rows[0];
    if (!seed) throw new Error(`empty super-category bucket for ${code}`);
    const cheapest = rows.reduce((min, r) => (r.pricePerGuest < min.pricePerGuest ? r : min), seed);
    return {
      superCategoryCode: code,
      superCategoryName: code,
      bestRate: cabinToBestRate(cheapest),
    };
  });

  const leadDescription = cabins[0]?.leadPromotionShortDescription ?? "BASE";
  const response = successEnvelope({
    promotionBestPrices: [
      {
        leadPromotion: { promotionId: leadDescription, shortDescription: leadDescription },
        eligible: true,
        combinableWith: [],
        superCategoryBestPrices,
      },
    ],
  }) as SuperCategoryPricingResponse;

  setCachedResponse(cached.key, response);
  return response;
}

/**
 * Returns one `categoryBestPrices[]` row per distinct stateroom category.
 */
export async function getCategoryPricing(
  request: PricingRequestBase
): Promise<CategoryPricingResponse> {
  const endpoint = "/v1/partner-pricing/category-pricing";
  const cached = getCachedResponse<CategoryPricingResponse>(endpoint, request);
  if (cached.value) return cached.value;

  const cabins = await scrapeAndPersist(request, "category");

  const categoryBestPrices = cabins.map((c) => ({
    stateroomCategoryCode: c.stateroomCategoryCode,
    bestRate: cabinToBestRate(c),
  }));

  const leadDescription = cabins[0]?.leadPromotionShortDescription ?? "BASE";
  const response = successEnvelope({
    promotionBestPrices: [
      {
        leadPromotion: { promotionId: leadDescription, shortDescription: leadDescription },
        eligible: true,
        combinableWith: [],
        categoryBestPrices,
      },
    ],
    categoryBestPrices,
  }) as CategoryPricingResponse;

  setCachedResponse(cached.key, response);
  return response;
}

/**
 * Group pricing. The public UI doesn't expose group shells, so the
 * scraper flow is the same as category pricing and we synthesize a
 * single group id. Real group data would come from an authenticated
 * agency login flow (out of scope for v1).
 */
export async function getGroupPricing(request: PricingRequestBase): Promise<GroupPricingResponse> {
  const endpoint = "/v1/partner-pricing/group-pricing";
  const cached = getCachedResponse<GroupPricingResponse>(endpoint, request);
  if (cached.value) return cached.value;

  const cabins = await scrapeAndPersist(request, "group");

  const allocatedCategoryBestPrices = cabins.map((c) => ({
    stateroomCategoryCode: c.stateroomCategoryCode,
    bestRate: cabinToBestRate(c),
  }));

  const response = successEnvelope({
    groupBestPrices: [
      {
        groupId: "PUBLIC",
        allocatedCategoryBestPrices,
      },
    ],
  }) as GroupPricingResponse;

  setCachedResponse(cached.key, response);
  return response;
}
