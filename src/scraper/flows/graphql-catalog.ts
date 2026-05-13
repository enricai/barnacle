import { addDays, formatISO, parseISO } from "date-fns";

import { getLogger } from "@/lib/logging";
import type { SailingPackageFlowInput, ScrapedSailing } from "@/scraper/flows/sailing-package";
import {
  type CruiseSearchResults,
  cruiseSearchCruises,
  type GraphQlCruise,
  type GraphQlItineraryDay,
  type GraphQlStateroomClassPrice,
  type GraphQlTour,
} from "@/scraper/graphql";

const logger = getLogger({ name: "scraper/flows/graphql-catalog" });

const PAGE_SIZE = 50;
const DEFAULT_MAX_PAGES = 20;

/**
 * GraphQL-backed catalog flow. Runs `cruiseSearch_Cruises` directly
 * against RC's public `/cruises/graph` endpoint — no browser, no Steel
 * session. Replaces the Stagehand flow for the hot catalog path; the
 * Stagehand flow becomes a fallback for when GraphQL drifts or errors.
 *
 * Filter strategy (per recon gap 7): RC's `$filters` string only
 * applies the FIRST key:value predicate. So we pick the most-selective
 * single predicate and enforce the rest client-side:
 *   1. shipCodes (if given) — send the first as `ship:XX`
 *   2. otherwise — empty filter, paginate full catalog
 * The date-window, remaining ship codes, and includeTourPackages are
 * applied client-side on the response.
 */

type FetchFn = (skip: number, count: number, filters: string) => Promise<CruiseSearchResults>;

interface GraphqlCatalogOptions {
  fetchFn?: FetchFn;
  maxPages?: number;
  pageSize?: number;
}

/**
 * Runs the direct-HTTP catalog query and maps results to
 * `ScrapedSailing[]` — the same shape the Stagehand flow produces, so
 * downstream services consume both identically.
 */
export async function fetchSailingPackagesViaGraphql(
  input: SailingPackageFlowInput,
  options: GraphqlCatalogOptions = {}
): Promise<ScrapedSailing[]> {
  const fetchFn = options.fetchFn ?? defaultFetch;
  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
  const pageSize = options.pageSize ?? PAGE_SIZE;

  const filters = pickMostSelectiveFilter(input);
  logger.info(
    `graphql catalog: brand=${input.brandCode} filters="${filters}" window=${input.fromSailDate}..${input.toSailDate}`
  );
  if (input.guestCount !== undefined) {
    // RC's catalog response already prices per-guest; guestCount
    // doesn't change pricing or availability at this layer. Log for
    // observability but take no action.
    logger.info(`guestCount=${input.guestCount} received — catalog pricing is per-guest already`);
  }

  const seen = new Set<string>();
  const collected: ScrapedSailing[] = [];
  for (let page = 0; page < maxPages; page += 1) {
    const skip = page * pageSize;
    const results = await fetchFn(skip, pageSize, filters);
    const cruises = results.cruises ?? [];
    if (cruises.length === 0) break;
    for (const cruise of cruises) {
      for (const sailing of expandCruiseToSailings(cruise, input)) {
        const key = `${sailing.shipCode}|${sailing.sailDate}|${sailing.packageCode}`;
        if (seen.has(key)) continue;
        seen.add(key);
        collected.push(sailing);
      }
    }
    // `total` is non-deterministic per recon — stop when page was
    // short rather than trusting it.
    if (cruises.length < pageSize) break;
  }

  logger.info(`graphql catalog: collected ${collected.length} sailings`);
  return collected;
}

/**
 * Default fetcher — lets callers inject a mock for unit tests without
 * monkey-patching the module.
 */
async function defaultFetch(
  skip: number,
  count: number,
  filters: string
): Promise<CruiseSearchResults> {
  return cruiseSearchCruises({
    filters,
    pagination: { count, skip },
    sort: { by: "RECOMMENDED" },
  });
}

/**
 * Chooses a single predicate for the `$filters` variable. Recon
 * confirmed multi-key AND is silently dropped, so one predicate is all
 * we get server-side. Remaining VPS predicates are applied client-side
 * in `expandCruiseToSailings`.
 *
 * Selectivity order (most → least selective, since RC keeps the first
 * match only): exact `ship` > exact `departurePort` > exact `destination`
 * > `cruiseLength`. Multiple values on any one key (e.g. two ships)
 * collapse to empty filter and pure client-side filtering — RC ignores
 * them anyway.
 */
export function pickMostSelectiveFilter(input: SailingPackageFlowInput): string {
  if (input.shipCodes && input.shipCodes.length === 1 && input.shipCodes[0]) {
    return `ship:${input.shipCodes[0]}`;
  }
  if (input.departurePorts && input.departurePorts.length === 1 && input.departurePorts[0]) {
    return `departurePort:${input.departurePorts[0]}`;
  }
  if (input.destinations && input.destinations.length === 1 && input.destinations[0]) {
    return `destination:${input.destinations[0]}`;
  }
  if (input.cruiseLengthRange && input.cruiseLengthRange.min === input.cruiseLengthRange.max) {
    return `cruiseLength:${input.cruiseLengthRange.min}`;
  }
  return "";
}

const CABIN_TYPE_TO_CLASS_ID: Record<NonNullable<SailingPackageFlowInput["cabinType"]>, string> = {
  INTERIOR: "I",
  OUTSIDE: "O",
  BALCONY: "B",
  SUITE: "D",
};

/**
 * Flattens one GraphQL `cruise` into the one-row-per-sailing-date
 * shape VPS expects. Applies the date window + ship-code filter
 * client-side. Skips sailings with no usable price (rare but possible
 * for recently-cancelled dates).
 */
export function expandCruiseToSailings(
  cruise: GraphQlCruise,
  input: SailingPackageFlowInput
): ScrapedSailing[] {
  const itinerary = cruise.masterSailing?.itinerary;
  if (!itinerary) return [];
  const packageCode = itinerary.code;
  const shipCode = itinerary.ship?.code ?? "";
  const shipName = itinerary.ship?.name;
  if (!packageCode || !shipCode) return [];

  if (input.shipCodes && input.shipCodes.length > 0 && !input.shipCodes.includes(shipCode)) {
    return [];
  }

  const destinationCode = itinerary.destination?.code;
  if (
    input.destinations &&
    input.destinations.length > 0 &&
    (!destinationCode || !input.destinations.includes(destinationCode))
  ) {
    return [];
  }

  const departurePortCode = itinerary.departurePort?.code;
  if (
    input.departurePorts &&
    input.departurePorts.length > 0 &&
    (!departurePortCode || !input.departurePorts.includes(departurePortCode))
  ) {
    return [];
  }

  const cruiseNights = itinerary.totalNights ?? itinerary.sailingNights ?? 0;
  if (
    input.cruiseLengthRange &&
    (cruiseNights < input.cruiseLengthRange.min || cruiseNights > input.cruiseLengthRange.max)
  ) {
    return [];
  }

  const fromDate = input.fromSailDate;
  const toDate = input.toSailDate;
  const detailPath = cruise.productViewLink
    ? cruise.productViewLink.startsWith("http")
      ? cruise.productViewLink
      : `https://www.royalcaribbean.com/${cruise.productViewLink.replace(/^\//, "")}`
    : undefined;

  const sailings = cruise.sailings ?? [];
  const expanded: ScrapedSailing[] = [];
  const cruiseDuration = itinerary.totalNights ?? itinerary.sailingNights ?? 0;
  const hasTour = Boolean(itinerary.preTour || itinerary.postTour);
  const shouldIncludeTours = input.includeTourPackages !== false && hasTour;
  // VPS cruiseOnly flag: true iff no tour packages are attached —
  // derivable without a separate upstream field.
  const cruiseOnly = !hasTour;
  const requiredClassId = input.cabinType ? CABIN_TYPE_TO_CLASS_ID[input.cabinType] : undefined;
  for (const sailing of sailings) {
    if (sailing.sailDate < fromDate || sailing.sailDate > toDate) continue;
    const cabinOptions = mapStateroomClassPricing(sailing.stateroomClassPricing ?? []);
    if (
      requiredClassId &&
      !cabinOptions.some((c) => c.stateroomSuperCategory === requiredClassId)
    ) {
      continue;
    }
    // sailingItinerary + tours are built per-sailing because VPS
    // expects each schedule entry to carry a concrete date. The port
    // sequence is shared across sailings of the same cruise, but the
    // dates differ.
    const sailingItinerary = mapItineraryDays(
      itinerary.code,
      cruiseDuration || undefined,
      itinerary.days,
      itinerary.type,
      itinerary.voyageType,
      sailing.sailDate
    );
    const tours = mapTours(itinerary.preTour, itinerary.postTour, sailing.sailDate, cruiseDuration);
    expanded.push({
      brandCode: input.brandCode,
      shipCode,
      shipName,
      sailDate: sailing.sailDate,
      packageCode,
      duration: itinerary.totalNights ?? itinerary.sailingNights ?? 0,
      packageDescription: itinerary.name,
      sailingStatus: sailing.status,
      cruiseOnly,
      regionCode: itinerary.destination?.code,
      subRegionCode: itinerary.departurePort?.region,
      bookingUrl: detailPath,
      sailingItinerary,
      tours: shouldIncludeTours && tours.length > 0 ? tours : undefined,
      cabinOptions: cabinOptions.length > 0 ? cabinOptions : undefined,
    });
  }
  return expanded;
}

/**
 * Maps RC's pre/postTour pair into the VPS `tours[]` shape. Each tour
 * carries the same Day structure as the main itinerary, so we reuse
 * the same day→schedule flattening — just tagged with PRE/POST.
 *
 * Date derivation, matching the VPS fixture's convention:
 * - PRE tour day 1 = sailDate - tourDuration (ends the day before embark)
 * - POST tour day 1 = sailDate + cruiseDuration (starts day of debark)
 *
 * Returns an empty array when neither tour is set (most sailings).
 */
function mapTours(
  preTour: GraphQlTour | null | undefined,
  postTour: GraphQlTour | null | undefined,
  sailDate: string,
  cruiseDuration: number
): NonNullable<ScrapedSailing["tours"]> {
  const out: NonNullable<ScrapedSailing["tours"]> = [];
  const sailDateIso = parseISO(sailDate);
  if (preTour) {
    const preDuration = preTour.duration ?? 0;
    const preAnchor =
      preDuration > 0
        ? formatISO(addDays(sailDateIso, -preDuration), { representation: "date" })
        : undefined;
    out.push({
      tourCode: preTour.code,
      tourTypeCode: "PRE",
      duration: preTour.duration ?? undefined,
      schedule: flattenDaysToSchedule(preTour.days ?? undefined, preAnchor),
    });
  }
  if (postTour) {
    const postAnchor = formatISO(addDays(sailDateIso, cruiseDuration), {
      representation: "date",
    });
    out.push({
      tourCode: postTour.code,
      tourTypeCode: "POST",
      duration: postTour.duration ?? undefined,
      schedule: flattenDaysToSchedule(postTour.days ?? undefined, postAnchor),
    });
  }
  return out;
}

/**
 * Flattens RC's `Day[]` (with nested `PortVisit[]`) into the VPS
 * schedule shape: one entry per day/port combination. A multi-port
 * day emits multiple entries with the same dayNumber. Cruising days
 * (at sea) still emit a row — RC uses port code "CRU" for those,
 * and VPS clients expect complete day-by-day coverage.
 */
function mapItineraryDays(
  itineraryCode: string | undefined,
  duration: number | undefined,
  days: GraphQlItineraryDay[] | undefined,
  itineraryType: string | undefined,
  voyageType: string | undefined,
  sailDate: string | undefined
): ScrapedSailing["sailingItinerary"] | undefined {
  if (!days || days.length === 0) return undefined;
  return {
    itineraryCode,
    duration,
    itineraryType: itineraryType ?? undefined,
    voyageType: voyageType ?? undefined,
    schedule: flattenDaysToSchedule(days, sailDate),
  };
}

/**
 * Shared day×ports flattener — used for both the main itinerary and
 * pre/postTour schedules, since RC reuses the Day type on both.
 * When a sailDate is provided (main itinerary path), derive each
 * entry's date as sailDate + dayNumber - 1. Tours don't get a date
 * because RC doesn't expose an anchor date for pre/post extensions.
 */
function flattenDaysToSchedule(
  days: GraphQlItineraryDay[] | undefined,
  sailDate?: string
): NonNullable<ScrapedSailing["sailingItinerary"]>["schedule"] {
  if (!days || days.length === 0) return [];
  const anchor = sailDate ? parseISO(sailDate) : null;
  const schedule: NonNullable<ScrapedSailing["sailingItinerary"]>["schedule"] = [];
  for (const day of days) {
    const date = anchor
      ? formatISO(addDays(anchor, day.number - 1), { representation: "date" })
      : undefined;
    const ports = day.ports ?? [];
    if (ports.length === 0) {
      schedule.push({ dayNumber: day.number, date });
      continue;
    }
    for (const visit of ports) {
      schedule.push({
        dayNumber: day.number,
        date,
        portCode: visit.port?.code,
        portName: visit.port?.name ?? undefined,
        countryCode: visit.port?.countryCode ?? undefined,
        region: visit.port?.region ?? undefined,
        activity: visit.activity,
        arrivalTime: visit.arrivalTime ?? undefined,
        departureTime: visit.departureTime ?? undefined,
      });
    }
  }
  return schedule;
}

/**
 * Converts RC's `StateroomClassPrice[]` (I/O/B/D super-categories)
 * into the `ScrapedSailing.cabinOptions` shape. Codes are already the
 * VPS single-letter super-category codes.
 */
function mapStateroomClassPricing(prices: GraphQlStateroomClassPrice[]): {
  stateroomCategoryCode: string;
  stateroomSuperCategory: string;
  pricePerGuest: number;
  currency: string | undefined;
}[] {
  return prices
    .map((p) => {
      const code = p.stateroomClass?.content?.code ?? p.stateroomClass?.id ?? "";
      if (!code || typeof p.price?.value !== "number") return null;
      return {
        stateroomCategoryCode: code,
        stateroomSuperCategory: p.stateroomClass.id,
        pricePerGuest: p.price.value,
        currency: p.price.currency?.code,
      };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);
}
