import { z } from "zod";

import { getLogger } from "@/lib/logging";
import { EmptyResultsError } from "@/scraper/errors";
import type { BrowserSession } from "@/scraper/session";
import { scheduleAction } from "@/scraper/throttle";

const logger = getLogger({ name: "scraper/flows/sailing-package" });

/**
 * Input shape derived from VPS's sailing-package request. Flows accept
 * the parsed request body verbatim — no mapping layer.
 */
export interface SailingPackageFlowInput {
  brandCode: string;
  fromSailDate: string;
  toSailDate: string;
  shipCodes?: string[];
  /**
   * VPS Task 8 extended filter set (POST /v1/search). RC's GraphQL
   * `$filters` accepts only one server-side predicate, so these are
   * applied client-side in `expandCruiseToSailings` except for the one
   * picked by `pickMostSelectiveFilter`.
   */
  destinations?: string[];
  departurePorts?: string[];
  cruiseLengthRange?: { min: number; max: number };
  guestCount?: number;
  cabinType?: "INTERIOR" | "OUTSIDE" | "BALCONY" | "SUITE";
  includeTourPackages?: boolean;
  /**
   * Hard cap on pagination passes. Prevents runaway scraping when the RC
   * site has thousands of matches. Each pass either clicks "next" or
   * scrolls to load more results.
   */
  maxPaginationPasses?: number;
  /**
   * When set, also opens each sailing's detail page and extracts cabin-
   * level pricing (Task 6's secondary extract). Capped by
   * `maxDetailEnrichments` so we don't open 500 pages for free.
   */
  enrichPricing?: boolean;
  maxDetailEnrichments?: number;
}

const DEFAULT_MAX_PAGES = 10;
const DEFAULT_MAX_DETAILS = 20;

const scrapedCabinSchema = z.object({
  stateroomCategoryCode: z.string(),
  stateroomSuperCategory: z.string().optional(),
  pricePerGuest: z.number(),
  currency: z.string().optional(),
});

const scrapedItineraryStopSchema = z.object({
  dayNumber: z.number().int(),
  // YYYY-MM-DD derived as sailDate + dayNumber - 1. RC's GraphQL Day
  // type doesn't expose a date directly, so we compute it per-sailing.
  date: z.string().optional(),
  portCode: z.string().optional(),
  portName: z.string().optional(),
  // VPS wants the country name ("UNITED STATES"); RC's GraphQL only
  // exposes a region string (mixes country + US state) and a 3-letter
  // countryCode. We surface both under their canonical VPS-adjacent
  // names rather than stuffing region into countryName — clients that
  // need a display label can do their own code→name lookup.
  countryCode: z.string().nullable().optional(),
  countryName: z.string().nullable().optional(),
  region: z.string().nullable().optional(),
  activity: z.string().optional(),
  arrivalTime: z.string().nullable().optional(),
  departureTime: z.string().nullable().optional(),
});

const scrapedItinerarySchema = z.object({
  itineraryCode: z.string().optional(),
  duration: z.number().int().optional(),
  // RC's GraphQL exposes `type` ("CRUISE") and `voyageType` ("OCEAN").
  // VPS fixtures carry single-letter codes ("C", "O"), but we surface
  // the RC-native strings here and let clients map if they need the
  // short form — 1:1 translation isn't reliably inferable.
  itineraryType: z.string().nullable().optional(),
  voyageType: z.string().optional(),
  schedule: z.array(scrapedItineraryStopSchema),
});

const scrapedTourPackageSchema = z.object({
  tourCode: z.string(),
  tourTypeCode: z.enum(["PRE", "POST"]),
  duration: z.number().int().optional(),
  schedule: z.array(scrapedItineraryStopSchema).optional(),
});

const scrapedSailingSchema = z.object({
  brandCode: z.string(),
  shipCode: z.string(),
  shipName: z.string().optional(),
  sailDate: z.string(),
  packageCode: z.string(),
  duration: z.number().int(),
  packageDescription: z.string().optional(),
  // VPS fixture uses "ACTIVE"; RC GraphQL emits "OPEN". We pass
  // RC-native values through — VPS clients get a populated field
  // either way, and the vocabulary difference is a known recon gap.
  sailingStatus: z.string().optional(),
  // Derived from the pre/postTour presence — true iff neither tour
  // is attached. Matches the VPS fixture's usage.
  cruiseOnly: z.boolean().optional(),
  regionCode: z.string().optional(),
  subRegionCode: z.string().optional(),
  bookingUrl: z.string().optional(),
  sailingItinerary: scrapedItinerarySchema.optional(),
  tours: z.array(scrapedTourPackageSchema).optional(),
  cabinOptions: z.array(scrapedCabinSchema).optional(),
});

const sailingScrapeSchema = z.object({
  sailings: z.array(scrapedSailingSchema),
});

export type ScrapedSailing = z.infer<typeof scrapedSailingSchema>;

const paginationProbeSchema = z.object({
  hasMore: z.boolean(),
  method: z.enum(["next-button", "scroll", "none"]).optional(),
});

const cabinExtractSchema = z.object({
  cabinOptions: z.array(scrapedCabinSchema),
});

/**
 * Drives the RC cruise-search UI and returns a list of sailings.
 *
 * Task 5: filters are applied via `page.act()`, one discrete call per
 * filter, throttled through the session limiter.
 *
 * Task 6: we paginate — up to `maxPaginationPasses` iterations of
 * "click next" or "scroll to load more", deciding which via an extract
 * against `paginationProbeSchema`. Secondary per-sailing pricing
 * extract is opt-in via `enrichPricing`, capped so we don't run up
 * Steel minutes on a huge result set.
 *
 * Task 10: empty results after pagination surface as EmptyResultsError
 * which the service layer converts to an empty-array envelope.
 *
 * Selector/prompt text is intentionally generic — real production
 * recon (TASKS.md Task 3) tunes these against the live DOM. What's
 * locked is the CONTRACT: typed input, typed output, deterministic
 * throttling.
 */
export async function scrapeSailingPackages(
  session: BrowserSession,
  input: SailingPackageFlowInput
): Promise<ScrapedSailing[]> {
  const { stagehand, limiter } = session;
  const page = stagehand.page;

  logger.info(
    `scraping sailings: brand=${input.brandCode} window=${input.fromSailDate}..${input.toSailDate} ships=${(input.shipCodes ?? []).join(",") || "any"}`
  );

  await scheduleAction(limiter, () => page.goto("https://www.royalcaribbean.com/cruises"));

  await scheduleAction(limiter, () =>
    page.act(
      `apply the cruise search filter for departure date range ${input.fromSailDate} to ${input.toSailDate}`
    )
  );

  if (input.shipCodes && input.shipCodes.length > 0) {
    await scheduleAction(limiter, () =>
      page.act(`filter to only the following ship codes: ${input.shipCodes?.join(", ")}`)
    );
  }

  if (input.destinations && input.destinations.length > 0) {
    await scheduleAction(limiter, () =>
      page.act(`filter by destination region. Select only: ${input.destinations?.join(", ")}`)
    );
  }

  if (input.departurePorts && input.departurePorts.length > 0) {
    await scheduleAction(limiter, () =>
      page.act(`filter by departure port. Select only: ${input.departurePorts?.join(", ")}`)
    );
  }

  if (input.cruiseLengthRange) {
    const { min, max } = input.cruiseLengthRange;
    await scheduleAction(limiter, () =>
      page.act(`filter by cruise length. Select cruises between ${min} and ${max} nights inclusive`)
    );
  }

  if (input.cabinType) {
    await scheduleAction(limiter, () => page.act(`filter by stateroom type: ${input.cabinType}`));
  }

  if (input.guestCount !== undefined) {
    logger.info(
      `guestCount=${input.guestCount} is advisory — RC search does not gate availability by guests at this step`
    );
  }

  const maxPasses = input.maxPaginationPasses ?? DEFAULT_MAX_PAGES;
  const collected = new Map<string, ScrapedSailing>();

  const extractPass = async (): Promise<void> => {
    const extracted = await scheduleAction(limiter, () =>
      page.extract({
        instruction:
          "extract every visible sailing card with shipCode, shipName, sailDate (YYYY-MM-DD), packageCode, duration, packageDescription, regionCode, subRegionCode, and the bookingUrl (deep link to the sailing detail or booking page) if visible on the card",
        schema: sailingScrapeSchema,
      })
    );
    for (const s of extracted.sailings) {
      // Dedup by the VPS identity tuple — pagination may overlap.
      const key = `${s.shipCode}|${s.sailDate}|${s.packageCode}`;
      if (!collected.has(key)) {
        collected.set(key, { ...s, brandCode: input.brandCode });
      }
    }
  };

  await extractPass();

  for (let pass = 0; pass < maxPasses; pass += 1) {
    const probe = await scheduleAction(limiter, () =>
      page.extract({
        instruction:
          "report whether more sailing results can be loaded. Set hasMore=true if a 'next' or 'load more' button exists, OR if scrolling to the bottom would fetch more results. Set method to 'next-button', 'scroll', or 'none'.",
        schema: paginationProbeSchema,
      })
    );
    if (!probe.hasMore) break;
    if (probe.method === "next-button") {
      await scheduleAction(limiter, () =>
        page.act("click the 'next' or 'load more' button to load additional sailing results")
      );
    } else {
      await scheduleAction(limiter, () =>
        page.act(
          "scroll the sailing results list to the bottom to trigger infinite-scroll loading of more results"
        )
      );
    }
    await extractPass();
  }

  if (input.enrichPricing) {
    const cap = input.maxDetailEnrichments ?? DEFAULT_MAX_DETAILS;
    const toEnrich = Array.from(collected.values())
      .filter((s) => s.bookingUrl)
      .slice(0, cap);
    for (const sailing of toEnrich) {
      const cabinOptions = await enrichSailingWithPricing(session, sailing);
      if (cabinOptions.length > 0) {
        sailing.cabinOptions = cabinOptions;
      }
    }
    if (toEnrich.length > 0) {
      // Return to the results list in case the caller wants to scrape again.
      await scheduleAction(limiter, () => page.goto("https://www.royalcaribbean.com/cruises"));
    }
  }

  const sailings = Array.from(collected.values());
  if (sailings.length === 0) {
    throw new EmptyResultsError();
  }
  return sailings;
}

/**
 * Secondary extract for Task 6 — opens one sailing detail page and
 * pulls cabin-level pricing. Separate function so services can call
 * it on demand outside the main scrape loop if they already have
 * sailing identities from the catalog + snapshot.
 */
export async function enrichSailingWithPricing(
  session: BrowserSession,
  sailing: ScrapedSailing
): Promise<z.infer<typeof scrapedCabinSchema>[]> {
  if (!sailing.bookingUrl) return [];
  const { stagehand, limiter } = session;
  const page = stagehand.page;
  try {
    await scheduleAction(limiter, () => page.goto(sailing.bookingUrl as string));
    const extracted = await scheduleAction(limiter, () =>
      page.extract({
        instruction:
          "extract every cabin / stateroom category offered for this sailing with stateroomCategoryCode, stateroomSuperCategory (I/O/B/D/A/C), pricePerGuest, and currency",
        schema: cabinExtractSchema,
      })
    );
    return extracted.cabinOptions;
  } catch (err) {
    logger.warn(
      `enrich pricing failed for ${sailing.shipCode} ${sailing.sailDate} ${sailing.packageCode}: ${String(err)}`
    );
    return [];
  }
}
