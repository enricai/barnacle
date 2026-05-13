"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.startChangesWorker = startChangesWorker;
exports.runChangeDetection = runChangeDetection;
const croner_1 = require("croner");
const date_fns_1 = require("date-fns");
const config_1 = require("@/config");
const logging_1 = require("@/lib/logging");
const sailing_catalog_1 = require("@/services/sailing-catalog");
const logger = (0, logging_1.getLogger)({ name: "workers/changes" });
/**
 * Hourly change-detection worker. Mirrors RC VPS's 60-minute trickle
 * update cadence. On each tick it rescrapes a short forward window and
 * the snapshot writes power the three delta endpoints.
 *
 * We intentionally keep the sailing-level rescrape scope small (next
 * 60 days) to cap Steel session cost; operators tune this via
 * `CHANGES_CRON` and the worker's own logic.
 */
function startChangesWorker() {
    if (!config_1.config.workers.enabled) {
        logger.info("workers disabled by config; changes job not scheduled");
        return null;
    }
    const job = new croner_1.Cron(config_1.config.workers.changesCron, { name: "changes" }, async () => {
        await runChangeDetection();
    });
    logger.info(`changes worker scheduled: ${config_1.config.workers.changesCron}`);
    return job;
}
async function runChangeDetection() {
    const now = new Date();
    const to = (0, date_fns_1.addDays)(now, 60);
    const fromSailDate = (0, date_fns_1.formatISO)(now, { representation: "date" });
    const toSailDate = (0, date_fns_1.formatISO)(to, { representation: "date" });
    for (const brandCode of ["R", "C"]) {
        try {
            logger.info(`changes sweep: brand=${brandCode} ${fromSailDate}..${toSailDate}`);
            await (0, sailing_catalog_1.getSailingPackages)({
                brandCode,
                fromSailDate,
                toSailDate,
                includeTourPackages: false,
            });
        }
        catch (err) {
            logger.warn(`changes sweep failed for brand=${brandCode}: ${String(err)}`);
        }
    }
}
//# sourceMappingURL=changes.js.map