import PQueue from "p-queue";

import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db/client";

/**
 * Prisma-backed snapshot storage. Writes are idempotent by virtue of
 * capturedAt — every capture is a new row. Reads consume only the most
 * recent two rows per key to compute deltas.
 *
 * Why we don't update in place: keeping a history lets the delta
 * endpoints return accurate `fromDateTime` ranges and lets future
 * auditing replay pricing movement over time.
 */

/**
 * Caps how many payload-fetch pairs run against the DB at once during a
 * delta scan. `pg` defaults to a pool of 10; 8 leaves headroom for the
 * service layer's own prisma traffic. Two queries per key means each
 * loop iteration can occupy up to 2 pool slots, so the effective
 * ceiling here is ~4 concurrent keys — which is the actual cap.
 */
const DELTA_FETCH_CONCURRENCY = 8;

interface SailingSnapshotKey {
  brandCode: string;
  shipCode: string;
  sailDate: Date;
  packageCode: string;
}

export async function saveSailingSnapshot(
  key: SailingSnapshotKey,
  payload: unknown
): Promise<void> {
  await prisma.sailingSnapshot.create({
    data: {
      brandCode: key.brandCode,
      shipCode: key.shipCode,
      sailDate: key.sailDate,
      packageCode: key.packageCode,
      payload: payload as Prisma.InputJsonValue,
    },
  });
}

interface PricingSnapshotKey extends SailingSnapshotKey {
  currencyCode: string;
  occupancy: number;
  bookingTypeCode: string;
  /** `super-category`, `category`, or `group`. */
  granularity: string;
}

export async function savePricingSnapshot(
  key: PricingSnapshotKey,
  payload: unknown
): Promise<void> {
  await prisma.pricingSnapshot.create({
    data: {
      brandCode: key.brandCode,
      shipCode: key.shipCode,
      sailDate: key.sailDate,
      packageCode: key.packageCode,
      currencyCode: key.currencyCode,
      occupancy: key.occupancy,
      bookingTypeCode: key.bookingTypeCode,
      granularity: key.granularity,
      pricePayload: payload as Prisma.InputJsonValue,
    },
  });
}

interface PromotionSnapshotKey {
  brand: string;
  agencyId?: string;
  marketKey?: string;
}

export async function savePromotionSnapshot(
  key: PromotionSnapshotKey,
  payload: unknown
): Promise<void> {
  await prisma.promotionSnapshot.create({
    data: {
      brand: key.brand,
      agencyId: key.agencyId ?? null,
      marketKey: key.marketKey ?? null,
      payload: payload as Prisma.InputJsonValue,
    },
  });
}

/**
 * Stable JSON stringifier used as the change-detection fingerprint.
 * Prisma returns JSON as a JS object, so insertion order of keys can
 * drift between captures even when the logical content is identical
 * (RC's upstream sometimes reorders). Sorting keys before stringifying
 * keeps the delta honest.
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0
  );
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

/**
 * Returns sailing keys whose latest SailingSnapshot payload differs
 * from the most recent pre-`since` capture (or where no prior capture
 * exists at all). Naive "any row newer than cutoff" classifier would
 * report every re-observation as a change, which downstream delta
 * consumers take as a price/itinerary drift signal — false positives
 * waste their rescrape budget.
 *
 * Implementation pulls the distinct keys with post-`since` activity
 * and fetches their two relevant payloads in parallel under a
 * p-queue bounded by DELTA_FETCH_CONCURRENCY (so a large candidate
 * list doesn't saturate the pg pool). Avoids a SQL window function
 * for portability. For the expected change rate (thousands of
 * sailings, dozens drifting per hour) this is cheap.
 */
export async function findSailingKeysChangedSince(
  since: Date
): Promise<Array<{ shipCode: string; sailDate: Date; packageCode: string }>> {
  const candidates = await prisma.sailingSnapshot.findMany({
    where: { capturedAt: { gt: since } },
    select: { shipCode: true, sailDate: true, packageCode: true },
    distinct: ["shipCode", "sailDate", "packageCode"],
  });

  const queue = new PQueue({ concurrency: DELTA_FETCH_CONCURRENCY });
  type SailingKey = { shipCode: string; sailDate: Date; packageCode: string };
  const results = await Promise.all(
    candidates.map((key) =>
      queue.add(async (): Promise<SailingKey | null> => {
        const [latest, prior] = await Promise.all([
          prisma.sailingSnapshot.findFirst({
            where: {
              shipCode: key.shipCode,
              sailDate: key.sailDate,
              packageCode: key.packageCode,
              capturedAt: { gt: since },
            },
            orderBy: { capturedAt: "desc" },
            select: { payload: true },
          }),
          prisma.sailingSnapshot.findFirst({
            where: {
              shipCode: key.shipCode,
              sailDate: key.sailDate,
              packageCode: key.packageCode,
              capturedAt: { lte: since },
            },
            orderBy: { capturedAt: "desc" },
            select: { payload: true },
          }),
        ]);
        if (!latest) return null;
        if (!prior || stableStringify(latest.payload) !== stableStringify(prior.payload)) {
          return key;
        }
        return null;
      })
    )
  );
  return results.filter((x): x is SailingKey => x !== null && x !== undefined);
}

interface PriceChangeKeyRow {
  shipCode: string;
  sailDate: Date;
  packageCode: string;
  currencyCode: string;
  occupancy: number;
  bookingTypeCode: string;
}

/**
 * Returns pricing keys (tuples of sailing + currency + occupancy +
 * bookingType) whose latest post-`since` PricingSnapshot payload
 * differs from the last pre-`since` payload for the same key. Filters
 * by `granularity` ("super-category" vs "category") so each delta
 * endpoint keys off its own snapshot stream. Same payload-diff logic
 * as [[findSailingKeysChangedSince]].
 */
export async function findPricingKeysChangedSince(
  since: Date,
  granularity: "super-category" | "category"
): Promise<PriceChangeKeyRow[]> {
  const candidates = await prisma.pricingSnapshot.findMany({
    where: { capturedAt: { gt: since }, granularity },
    select: {
      shipCode: true,
      sailDate: true,
      packageCode: true,
      currencyCode: true,
      occupancy: true,
      bookingTypeCode: true,
    },
    // Include bookingTypeCode in the distinct-on columns so the per-
    // candidate find* queries below filter against the actual booking
    // type we collected for, not an arbitrary Prisma-picked row. Without
    // it, a (ship/date/package/currency/occupancy) tuple that has
    // deltas on both Individual ("I") and Group ("G") pricing would
    // surface only one booking type in the response — the other's
    // delta would be silently dropped.
    distinct: [
      "shipCode",
      "sailDate",
      "packageCode",
      "currencyCode",
      "occupancy",
      "bookingTypeCode",
    ],
  });

  const queue = new PQueue({ concurrency: DELTA_FETCH_CONCURRENCY });
  const results = await Promise.all(
    candidates.map((key) =>
      queue.add(async (): Promise<PriceChangeKeyRow | null> => {
        const [latest, prior] = await Promise.all([
          prisma.pricingSnapshot.findFirst({
            where: {
              shipCode: key.shipCode,
              sailDate: key.sailDate,
              packageCode: key.packageCode,
              currencyCode: key.currencyCode,
              occupancy: key.occupancy,
              bookingTypeCode: key.bookingTypeCode,
              granularity,
              capturedAt: { gt: since },
            },
            orderBy: { capturedAt: "desc" },
            select: { pricePayload: true },
          }),
          prisma.pricingSnapshot.findFirst({
            where: {
              shipCode: key.shipCode,
              sailDate: key.sailDate,
              packageCode: key.packageCode,
              currencyCode: key.currencyCode,
              occupancy: key.occupancy,
              bookingTypeCode: key.bookingTypeCode,
              granularity,
              capturedAt: { lte: since },
            },
            orderBy: { capturedAt: "desc" },
            select: { pricePayload: true },
          }),
        ]);
        if (!latest) return null;
        if (
          !prior ||
          stableStringify(latest.pricePayload) !== stableStringify(prior.pricePayload)
        ) {
          return key;
        }
        return null;
      })
    )
  );
  return results.filter((x): x is PriceChangeKeyRow => x !== null && x !== undefined);
}
