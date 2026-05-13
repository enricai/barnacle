import { successEnvelope } from "@/api/helpers/envelope";
import type {
  PromotionDetailsRequest,
  PromotionDetailsResponse,
} from "@/api/schemas/promotion-details";
import { getCachedResponse, getOrCreateInFlight } from "@/cache/response-cache";
import { EmptyResultsError } from "@/scraper/errors";
import { scrapePromotions } from "@/scraper/flows/promotions";
import { runWithSession } from "@/scraper/pool";
import { savePromotionSnapshot } from "@/snapshots/store";

const ENDPOINT = "/v1/promotion/promotion-details";

/**
 * Converts an ISO-ish date (`2024-09-01` or `2024-09-01T12:34:56`) into
 * RC's `YYYYMMDDHHMMSS` integer. Falls back to sentinel values when the
 * input is missing.
 */
function isoToNumericDateTime(input: string | undefined, fallback: number): number {
  if (!input) return fallback;
  const cleaned = input.replace(/\D/g, "").padEnd(14, "0").slice(0, 14);
  const parsed = Number.parseInt(cleaned, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

/**
 * Fetches the promotion catalog for a given brand + client-or-market
 * context. The public cruise-deals page is the scrape target; the
 * service layer fills in RC's restriction flags with conservative
 * defaults where the UI doesn't expose them.
 */
export async function getPromotionDetails(
  request: PromotionDetailsRequest
): Promise<PromotionDetailsResponse> {
  const cached = getCachedResponse<PromotionDetailsResponse>(ENDPOINT, request);
  if (cached.value) return cached.value;

  return getOrCreateInFlight<PromotionDetailsResponse>(cached.key, async () => {
    const currencyCodes = request.client?.currencyCodes ?? request.market?.currencyCodes ?? ["USD"];
    // Task 10: empty results → empty array, never a 500.
    const scraped = await runWithSession((session) =>
      scrapePromotions(session, {
        brand: request.brand,
        currencyCodes,
        marketCountryCode: request.market?.countryCode,
      })
    ).catch((err) => {
      if (err instanceof EmptyResultsError) {
        return [] as Awaited<ReturnType<typeof scrapePromotions>>;
      }
      throw err;
    });

    const promotions = scraped.map((p) => ({
      id: p.id,
      shortDescription: p.shortDescription,
      brand: request.brand,
      startDateTime: isoToNumericDateTime(p.startDate, 19700101000000),
      endDateTime: isoToNumericDateTime(p.endDate, 99991231235959),
      typeCode: p.typeCode,
      refundableType: p.refundableType,
      sailingRestricted: true,
      categoryRestricted: true,
      occupancyRestricted: false,
      gatewayRestricted: false,
      guestRestricted: false,
      promoCodeRestricted: false,
    }));

    const marketKey = request.market
      ? // Sort currencyCodes so ["USD","CAD"] and ["CAD","USD"] produce
        // the same snapshot key — the underlying market is identical,
        // and without this the two orderings would persist as separate
        // rows in promotion_snapshot even though they describe the same
        // RC response. canonicalReplacer handles the request-level cache
        // key the same way.
        `${request.market.officeCode}|${request.market.countryCode}|${[...request.market.currencyCodes].sort().join(",")}`
      : undefined;
    await savePromotionSnapshot(
      { brand: request.brand, agencyId: request.client?.agencyId, marketKey },
      promotions
    );

    return successEnvelope({ promotions }) as PromotionDetailsResponse;
  });
}
