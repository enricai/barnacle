"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.saveSailingSnapshot = saveSailingSnapshot;
exports.savePricingSnapshot = savePricingSnapshot;
exports.savePromotionSnapshot = savePromotionSnapshot;
exports.findSailingKeysChangedSince = findSailingKeysChangedSince;
exports.findPricingKeysChangedSince = findPricingKeysChangedSince;
const client_1 = require("@/lib/db/client");
async function saveSailingSnapshot(key, payload) {
    await client_1.prisma.sailingSnapshot.create({
        data: {
            brandCode: key.brandCode,
            shipCode: key.shipCode,
            sailDate: key.sailDate,
            packageCode: key.packageCode,
            payload: payload,
        },
    });
}
async function savePricingSnapshot(key, payload) {
    await client_1.prisma.pricingSnapshot.create({
        data: {
            brandCode: key.brandCode,
            shipCode: key.shipCode,
            sailDate: key.sailDate,
            packageCode: key.packageCode,
            currencyCode: key.currencyCode,
            occupancy: key.occupancy,
            bookingTypeCode: key.bookingTypeCode,
            granularity: key.granularity,
            pricePayload: payload,
        },
    });
}
async function savePromotionSnapshot(key, payload) {
    await client_1.prisma.promotionSnapshot.create({
        data: {
            brand: key.brand,
            agencyId: key.agencyId ?? null,
            marketKey: key.marketKey ?? null,
            payload: payload,
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
async function findSailingKeysChangedSince(since) {
    const rows = await client_1.prisma.sailingSnapshot.findMany({
        where: { capturedAt: { gt: since } },
        select: { shipCode: true, sailDate: true, packageCode: true },
        distinct: ["shipCode", "sailDate", "packageCode"],
    });
    return rows;
}
/**
 * Returns pricing keys (tuples of sailing + currency + occupancy +
 * bookingType) whose snapshot rows are newer than `since`. Filters by
 * `granularity` ("super-category" vs "category") so each delta endpoint
 * keys off its own snapshot stream.
 */
async function findPricingKeysChangedSince(since, granularity) {
    const rows = await client_1.prisma.pricingSnapshot.findMany({
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
//# sourceMappingURL=store.js.map