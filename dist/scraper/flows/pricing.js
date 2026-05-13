"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.scrapeSailingPricing = scrapeSailingPricing;
const zod_1 = require("zod");
const logging_1 = require("@/lib/logging");
const errors_1 = require("@/scraper/errors");
const throttle_1 = require("@/scraper/throttle");
const logger = (0, logging_1.getLogger)({ name: "scraper/flows/pricing" });
const pricingScrapeSchema = zod_1.z.object({
    cabinOptions: zod_1.z.array(zod_1.z.object({
        stateroomCategoryCode: zod_1.z.string(),
        stateroomSuperCategory: zod_1.z.string().optional(),
        stateroomTypeCode: zod_1.z.string().optional(),
        refundableFareFlag: zod_1.z.boolean().optional(),
        accessibleStateroomExistFlag: zod_1.z.boolean().optional(),
        pricePerGuest: zod_1.z.number(),
        netCruiseFareAmount: zod_1.z.number().optional(),
        taxesAndFeesAmount: zod_1.z.number().optional(),
        originalAmount: zod_1.z.number().optional(),
        leadPromotionShortDescription: zod_1.z.string().optional(),
    })),
});
/**
 * Drives the per-sailing pricing page and extracts cabin-level pricing.
 * Returns one row per stateroom category; the service layer folds these
 * into super-category / category / group response shapes.
 */
async function scrapeSailingPricing(session, input) {
    const { stagehand, limiter } = session;
    const page = stagehand.page;
    logger.info(`scraping pricing: ${input.shipCode} ${input.sailDate} ${input.packageCode} occ=${input.occupancy} cur=${input.currencyCode} type=${input.bookingTypeCode}`);
    const url = `https://www.royalcaribbean.com/cruise?shipCode=${encodeURIComponent(input.shipCode)}` +
        `&sailDate=${encodeURIComponent(input.sailDate)}&packageCode=${encodeURIComponent(input.packageCode)}`;
    await (0, throttle_1.scheduleAction)(limiter, () => page.goto(url));
    await (0, throttle_1.scheduleAction)(limiter, () => page.act(`set guest count to ${input.occupancy} and currency to ${input.currencyCode}${input.bookingTypeCode === "G" ? " and apply the group booking context" : ""}`));
    const extracted = await (0, throttle_1.scheduleAction)(limiter, () => page.extract({
        instruction: "extract every cabin / stateroom category shown with stateroomCategoryCode, stateroomSuperCategory (I/O/B/D/A/C), stateroomTypeCode, refundableFareFlag, accessibleStateroomExistFlag, pricePerGuest, netCruiseFareAmount, taxesAndFeesAmount, originalAmount, leadPromotionShortDescription",
        schema: pricingScrapeSchema,
    }));
    if (extracted.cabinOptions.length === 0) {
        throw new errors_1.EmptyResultsError();
    }
    return extracted.cabinOptions;
}
//# sourceMappingURL=pricing.js.map