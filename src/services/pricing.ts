import { successEnvelope } from "@/api/helpers/envelope";
import type { CategoryPricingResponse } from "@/api/schemas/category-pricing";
import type { GroupPricingResponse } from "@/api/schemas/group-pricing";
import type { PricingRequestBase } from "@/api/schemas/pricing-common";
import type { SuperCategoryPricingResponse } from "@/api/schemas/super-category-pricing";

/**
 * `getCategoryPricing` accepts the base pricing request plus an optional
 * per-category filter. Defined inline so the service module stays
 * decoupled from `@/api/schemas/category-pricing` (which pulls in the
 * response shape too).
 */
export interface CategoryPricingRequest extends PricingRequestBase {
  categoryCode?: string;
}

import { getCachedResponse, getOrCreateInFlight } from "@/cache/response-cache";
import { getLogger } from "@/lib/logging";
import { parseSailDateUtc } from "@/lib/sail-date";
import { EmptyResultsError } from "@/scraper/errors";
import { fetchSailingPricingViaGraphql } from "@/scraper/flows/graphql-pricing";
import { type PricingScrapeResult, scrapeSailingPricing } from "@/scraper/flows/pricing";
import { runWithSession } from "@/scraper/pool";
import { savePricingSnapshot } from "@/snapshots/store";

const logger = getLogger({ name: "services/pricing" });

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
  // Task 10: empty results are a legitimate outcome, not an error.
  // Translate the EmptyResultsError sentinel into [] here so downstream
  // response builders produce an empty-array envelope (200) instead of
  // bubbling up as a 500.
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
  ).catch((err) => {
    if (err instanceof EmptyResultsError) return [] as PricingScrapeResult;
    throw err;
  });

  if (cabins.length === 0) return cabins;

  await savePricingSnapshot(
    {
      brandCode: request.brandCode,
      shipCode: request.shipCode,
      sailDate: parseSailDateUtc(request.sailDate),
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
 * Projects RC's GraphQL stateroomClassPricing rows onto the shared
 * `PricingScrapeResult` shape so the GraphQL + Stagehand paths end up
 * persisting identical snapshots. This keeps the price-changes delta
 * endpoint working regardless of which path answered the request.
 */
function graphqlRowsToScrapeResult(
  rows: Awaited<ReturnType<typeof fetchSailingPricingViaGraphql>>
): PricingScrapeResult {
  if (!rows) return [];
  return rows.stateroomClassPricing
    .map((p) => {
      const code = p.stateroomClass?.content?.code ?? p.stateroomClass?.id;
      if (!code || typeof p.price?.value !== "number") return null;
      return {
        stateroomCategoryCode: code,
        stateroomSuperCategory: code,
        pricePerGuest: p.price.value,
        netCruiseFareAmount: p.price.netAmount,
        taxesAndFeesAmount: p.price.taxesAndFeesAmount,
        originalAmount: p.price.originalAmount,
      };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);
}

/**
 * Maps RC's GraphQL per-stateroom-class pricing (I/O/B/D) into the
 * super-category-pricing envelope directly. The catalog response already
 * includes per-sailing pricing by class, so no detail-page scrape is
 * needed when the sailing exists in the catalog (the 80% case).
 *
 * Also persists a super-category snapshot on success so the delta
 * endpoint (price-changes/super-category) sees this sailing move when
 * GraphQL is the source of truth.
 */
async function tryGraphqlSuperCategoryPricing(
  request: PricingRequestBase
): Promise<SuperCategoryPricingResponse | null> {
  const hit = await fetchSailingPricingViaGraphql({
    shipCode: request.shipCode,
    sailDate: request.sailDate,
    packageCode: request.packageCode,
  }).catch((err) => {
    logger.warn(`graphql super-category lookup failed: ${String(err).slice(0, 200)}`);
    return null;
  });
  if (!hit || hit.stateroomClassPricing.length === 0) return null;

  const superCategoryBestPrices = hit.stateroomClassPricing
    .map((p) => {
      const code = p.stateroomClass?.content?.code ?? p.stateroomClass?.id;
      if (!code || typeof p.price?.value !== "number") return null;
      return {
        superCategoryCode: code,
        superCategoryName: code,
        bestRate: {
          stateroomCategoryCode: code,
          stateroomSuperCategory: code,
          averagePerGuestPricePoint: {
            netTotal: p.price.value,
            netCruiseFareAmount: p.price.netAmount,
            taxesAndFeesAmount: p.price.taxesAndFeesAmount,
            originalAmount: p.price.originalAmount,
            includedInNetTotal: ["CFARE", "NCCF"],
          },
        },
      };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);

  if (superCategoryBestPrices.length === 0) return null;

  const snapshotRows = graphqlRowsToScrapeResult(hit);
  if (snapshotRows.length > 0) {
    await savePricingSnapshot(
      {
        brandCode: request.brandCode,
        shipCode: request.shipCode,
        sailDate: parseSailDateUtc(request.sailDate),
        packageCode: request.packageCode,
        currencyCode: request.currencyCode,
        occupancy: request.occupancy,
        bookingTypeCode: request.bookingTypeCode,
        granularity: "super-category",
      },
      snapshotRows
    );
  }

  return successEnvelope({
    promotionBestPrices: [
      {
        leadPromotion: { promotionId: "BASE", shortDescription: "BASE" },
        eligible: true,
        combinableWith: [],
        superCategoryBestPrices,
      },
    ],
  }) as SuperCategoryPricingResponse;
}

/**
 * Groups cabin rows by their super-category (I/O/B/D/A/C) and returns a
 * single `promotionBestPrices[]` entry with the observed lead promotion.
 *
 * Hot path: GraphQL catalog already carries Interior/Outside/Balcony/
 * Deluxe pricing inline per sailing, so we answer from that when the
 * sailing is present — zero Steel minutes. Stagehand is the fallback
 * for sailings GraphQL can't locate (cancelled, pending launch, etc).
 */
export async function getSuperCategoryPricing(
  request: PricingRequestBase
): Promise<SuperCategoryPricingResponse> {
  const endpoint = "/v1/partner-pricing/super-category-pricing";
  const cached = getCachedResponse<SuperCategoryPricingResponse>(endpoint, request);
  if (cached.value) return cached.value;

  return getOrCreateInFlight<SuperCategoryPricingResponse>(cached.key, async () => {
    const graphqlResponse = await tryGraphqlSuperCategoryPricing(request);
    if (graphqlResponse) {
      logger.info(
        `super-category from graphql: ${request.shipCode} ${request.sailDate} ${request.packageCode}`
      );
      return graphqlResponse;
    }

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
      const cheapest = rows.reduce(
        (min, r) => (r.pricePerGuest < min.pricePerGuest ? r : min),
        seed
      );
      return {
        superCategoryCode: code,
        superCategoryName: code,
        bestRate: cabinToBestRate(cheapest),
      };
    });

    const leadDescription = cabins[0]?.leadPromotionShortDescription ?? "BASE";
    return successEnvelope({
      promotionBestPrices: [
        {
          leadPromotion: { promotionId: leadDescription, shortDescription: leadDescription },
          eligible: true,
          combinableWith: [],
          superCategoryBestPrices,
        },
      ],
    }) as SuperCategoryPricingResponse;
  });
}

/**
 * Returns one `categoryBestPrices[]` row per distinct stateroom category.
 * When `categoryCode` is provided, narrows the response to matching rows
 * post-scrape — RC's inline pricing covers every category for the sailing,
 * and filtering after the fact avoids re-scraping when callers iterate
 * through a handful of specific categories.
 */
export async function getCategoryPricing(
  request: CategoryPricingRequest
): Promise<CategoryPricingResponse> {
  const endpoint = "/v1/partner-pricing/category-pricing";
  const cached = getCachedResponse<CategoryPricingResponse>(endpoint, request);
  if (cached.value) return cached.value;

  return getOrCreateInFlight<CategoryPricingResponse>(cached.key, async () => {
    const cabins = await scrapeAndPersist(request, "category");

    const filtered = request.categoryCode
      ? cabins.filter((c) => c.stateroomCategoryCode === request.categoryCode)
      : cabins;

    const categoryBestPrices = filtered.map((c) => ({
      stateroomCategoryCode: c.stateroomCategoryCode,
      bestRate: cabinToBestRate(c),
    }));

    const leadDescription = cabins[0]?.leadPromotionShortDescription ?? "BASE";
    return successEnvelope({
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
  });
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

  return getOrCreateInFlight<GroupPricingResponse>(cached.key, async () => {
    const cabins = await scrapeAndPersist(request, "group");

    const allocatedCategoryBestPrices = cabins.map((c) => ({
      stateroomCategoryCode: c.stateroomCategoryCode,
      bestRate: cabinToBestRate(c),
    }));

    return successEnvelope({
      groupBestPrices: [
        {
          groupId: "PUBLIC",
          allocatedCategoryBestPrices,
        },
      ],
    }) as GroupPricingResponse;
  });
}
