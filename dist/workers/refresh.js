"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.startRefreshWorker = startRefreshWorker;
exports.runRefresh = runRefresh;
const croner_1 = require("croner");
const date_fns_1 = require("date-fns");
const config_1 = require("@/config");
const logging_1 = require("@/lib/logging");
const sailing_catalog_1 = require("@/services/sailing-catalog");
const logger = (0, logging_1.getLogger)({ name: "workers/refresh" });
/**
 * Daily full refresh worker. Drives a baseline `sailing-package` scrape
 * for each supported brand across a rolling forward window so the
 * snapshot table stays warm and the delta endpoints have data to diff
 * against.
 *
 * Why croner: simple, accurate, maintained, zero-dep, handles DST and
 * timezones correctly out of the box.
 */
function startRefreshWorker() {
    if (!config_1.config.workers.enabled) {
        logger.info("workers disabled by config; refresh job not scheduled");
        return null;
    }
    const job = new croner_1.Cron(config_1.config.workers.refreshCron, { name: "refresh" }, async () => {
        await runRefresh();
    });
    logger.info(`refresh worker scheduled: ${config_1.config.workers.refreshCron}`);
    return job;
}
/**
 * Exposed so operators can trigger an ad-hoc refresh via the smoke-test
 * script or admin tooling.
 */
async function runRefresh() {
    const now = new Date();
    const to = (0, date_fns_1.addMonths)(now, 12);
    const fromSailDate = (0, date_fns_1.formatISO)(now, { representation: "date" });
    const toSailDate = (0, date_fns_1.formatISO)(to, { representation: "date" });
    for (const brandCode of ["R", "C"]) {
        try {
            logger.info(`refresh: brand=${brandCode} ${fromSailDate}..${toSailDate}`);
            await (0, sailing_catalog_1.getSailingPackages)({
                brandCode,
                fromSailDate,
                toSailDate,
                includeTourPackages: false,
            });
        }
        catch (err) {
            logger.warn(`refresh failed for brand=${brandCode}: ${String(err)}`);
        }
    }
}
//# sourceMappingURL=refresh.js.map