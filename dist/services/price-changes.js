"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getPriceChanges = getPriceChanges;
const date_fns_1 = require("date-fns");
const envelope_1 = require("@/api/helpers/envelope");
const store_1 = require("@/snapshots/store");
/**
 * Computes the delta response for `POST /v1/pricing-snapshot/price-
 * changes/{super-category|category}`. The `granularity` argument picks
 * which snapshot stream to compare against.
 */
async function getPriceChanges(fromDateTime, granularity) {
    const since = (0, date_fns_1.parseISO)(fromDateTime);
    const rows = await (0, store_1.findPricingKeysChangedSince)(since, granularity);
    const keys = rows.map((r) => ({
        shipCode: r.shipCode,
        sailDate: Number.parseInt(r.sailDate.toISOString().slice(0, 10).replace(/-/g, ""), 10),
        packageCode: r.packageCode,
        currencyCode: r.currencyCode,
        occupancy: r.occupancy,
        bookingType: r.bookingTypeCode,
    }));
    return (0, envelope_1.successEnvelope)({
        keys,
        dateTimeRange: {
            fromDateTime,
            toDateTime: new Date().toISOString(),
        },
    });
}
//# sourceMappingURL=price-changes.js.map