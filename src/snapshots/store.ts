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

export interface SailingSnapshotKey {
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
      payload: payload as never,
    },
  });
}

export interface PricingSnapshotKey extends SailingSnapshotKey {
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
      pricePayload: payload as never,
    },
  });
}

export interface PromotionSnapshotKey {
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
      payload: payload as never,
    },
  });
}

/**
 * Returns sailing keys whose latest SailingSnapshot payload is different
 * from the previous one captured before `since`. Simple implementation:
 * read every snapshot in (since, now], group by sailing identity, keep
 * keys where at least one capture exists. A future optimization would
 * diff payloads in SQL.
 */
export async function findSailingKeysChangedSince(
  since: Date
): Promise<Array<{ shipCode: string; sailDate: Date; packageCode: string }>> {
  const rows = await prisma.sailingSnapshot.findMany({
    where: { capturedAt: { gt: since } },
    select: { shipCode: true, sailDate: true, packageCode: true },
    distinct: ["shipCode", "sailDate", "packageCode"],
  });
  return rows;
}

export interface PriceChangeKeyRow {
  shipCode: string;
  sailDate: Date;
  packageCode: string;
  currencyCode: string;
  occupancy: number;
  bookingTypeCode: string;
}

/**
 * Returns pricing keys (tuples of sailing + currency + occupancy +
 * bookingType) whose snapshot rows are newer than `since`. Filters by
 * `granularity` ("super-category" vs "category") so each delta endpoint
 * keys off its own snapshot stream.
 */
export async function findPricingKeysChangedSince(
  since: Date,
  granularity: "super-category" | "category"
): Promise<PriceChangeKeyRow[]> {
  const rows = await prisma.pricingSnapshot.findMany({
    where: { capturedAt: { gt: since }, granularity },
    select: {
      shipCode: true,
      sailDate: true,
      packageCode: true,
      currencyCode: true,
      occupancy: true,
      bookingTypeCode: true,
    },
    distinct: ["shipCode", "sailDate", "packageCode", "currencyCode", "occupancy"],
  });
  return rows;
}
