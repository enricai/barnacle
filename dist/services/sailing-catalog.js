"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getSailingPackages = getSailingPackages;
exports.getSailingPackageChanges = getSailingPackageChanges;
const date_fns_1 = require("date-fns");
const envelope_1 = require("@/api/helpers/envelope");
const response_cache_1 = require("@/cache/response-cache");
const sailing_package_1 = require("@/scraper/flows/sailing-package");
const pool_1 = require("@/scraper/pool");
const store_1 = require("@/snapshots/store");
const ENDPOINT = "/v1/catalog/sailing-package";
/**
 * Fetches sailings for the given request. Hot-path goes straight through
 * the response cache; cold-path drives the scraper pool, persists a
 * snapshot per sailing (for the delta endpoint), and shapes the result
 * into VPS's SailingPackageResponse.
 */
async function getSailingPackages(request) {
    const cached = (0, response_cache_1.getCachedResponse)(ENDPOINT, request);
    if (cached.value)
        return cached.value;
    const sailings = await (0, pool_1.runWithSession)((session) => (0, sailing_package_1.scrapeSailingPackages)(session, request));
    for (const s of sailings) {
        await (0, store_1.saveSailingSnapshot)({
            brandCode: s.brandCode,
            shipCode: s.shipCode,
            sailDate: (0, date_fns_1.parseISO)(s.sailDate),
            packageCode: s.packageCode,
        }, s);
    }
    const response = (0, envelope_1.successEnvelope)({
        sailingPackages: sailings,
    });
    (0, response_cache_1.setCachedResponse)(cached.key, response);
    return response;
}
/**
 * Returns sailing keys that have changed since `fromDateTime`. Uses the
 * SailingSnapshot table — the daily refresh worker populates it, and the
 * delta endpoint reads against its own cutoff.
 */
async function getSailingPackageChanges(fromDateTime) {
    const since = (0, date_fns_1.parseISO)(fromDateTime);
    const rows = await (0, store_1.findSailingKeysChangedSince)(since);
    const keys = rows.map((r) => ({
        shipCode: r.shipCode,
        sailDate: Number.parseInt(r.sailDate.toISOString().slice(0, 10).replace(/-/g, ""), 10),
        packageCode: r.packageCode,
    }));
    return (0, envelope_1.successEnvelope)({
        keys,
        dateTimeRange: {
            fromDateTime,
            toDateTime: new Date().toISOString(),
        },
    });
}
//# sourceMappingURL=sailing-catalog.js.map