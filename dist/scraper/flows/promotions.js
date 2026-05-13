"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.scrapePromotions = scrapePromotions;
const zod_1 = require("zod");
const logging_1 = require("@/lib/logging");
const errors_1 = require("@/scraper/errors");
const throttle_1 = require("@/scraper/throttle");
const logger = (0, logging_1.getLogger)({ name: "scraper/flows/promotions" });
const promotionScrapeSchema = zod_1.z.object({
    promotions: zod_1.z.array(zod_1.z.object({
        id: zod_1.z.string(),
        shortDescription: zod_1.z.string().optional(),
        startDate: zod_1.z.string().optional(),
        endDate: zod_1.z.string().optional(),
        refundableType: zod_1.z.string().optional(),
        typeCode: zod_1.z.string().optional(),
    })),
});
/**
 * Drives the RC promotions listing page and extracts live promotions.
 * This flow intentionally returns a loose shape — the service layer
 * normalizes into VPS's promotion-details response, filling defaults
 * for `sailingRestricted`/`categoryRestricted`/etc when not observable.
 */
async function scrapePromotions(session, input) {
    const { stagehand, limiter } = session;
    const page = stagehand.page;
    logger.info(`scraping promotions: brand=${input.brand} currencies=${input.currencyCodes.join(",")}`);
    await (0, throttle_1.scheduleAction)(limiter, () => page.goto("https://www.royalcaribbean.com/cruise-deals"));
    if (input.marketCountryCode) {
        await (0, throttle_1.scheduleAction)(limiter, () => page.act(`switch the site market/country to ${input.marketCountryCode}`));
    }
    const extracted = await (0, throttle_1.scheduleAction)(limiter, () => page.extract({
        instruction: "extract every currently active promotion with its id/code, shortDescription, startDate and endDate (ISO or YYYY-MM-DD), refundableType, typeCode",
        schema: promotionScrapeSchema,
    }));
    if (extracted.promotions.length === 0) {
        throw new errors_1.EmptyResultsError();
    }
    return extracted.promotions;
}
//# sourceMappingURL=promotions.js.map