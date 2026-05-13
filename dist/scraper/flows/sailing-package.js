"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.scrapeSailingPackages = scrapeSailingPackages;
const zod_1 = require("zod");
const logging_1 = require("@/lib/logging");
const errors_1 = require("@/scraper/errors");
const throttle_1 = require("@/scraper/throttle");
const logger = (0, logging_1.getLogger)({ name: "scraper/flows/sailing-package" });
const sailingScrapeSchema = zod_1.z.object({
    sailings: zod_1.z.array(zod_1.z.object({
        brandCode: zod_1.z.string(),
        shipCode: zod_1.z.string(),
        shipName: zod_1.z.string().optional(),
        sailDate: zod_1.z.string(),
        packageCode: zod_1.z.string(),
        duration: zod_1.z.number().int(),
        packageDescription: zod_1.z.string().optional(),
        regionCode: zod_1.z.string().optional(),
        subRegionCode: zod_1.z.string().optional(),
    })),
});
/**
 * Drives the RC cruise-search UI and returns a list of sailings. The
 * selector/prompt work is lean and intentionally replaceable — real
 * production recon (per TASKS.md Task 3) pins these prompts against the
 * live DOM. What's locked in here is the CONTRACT: a typed input, a
 * typed return shape that services map into the VPS SailingPackage
 * schema, and throttled AI calls via `scheduleAction`.
 *
 * How to apply: services call this via `runWithSession` in pool.ts so
 * retries + timeouts + session teardown are handled uniformly.
 */
async function scrapeSailingPackages(session, input) {
    const { stagehand, limiter } = session;
    const page = stagehand.page;
    logger.info(`scraping sailings: brand=${input.brandCode} window=${input.fromSailDate}..${input.toSailDate} ships=${(input.shipCodes ?? []).join(",") || "any"}`);
    await (0, throttle_1.scheduleAction)(limiter, () => page.goto("https://www.royalcaribbean.com/cruises"));
    await (0, throttle_1.scheduleAction)(limiter, () => page.act(`apply the cruise search filter for departure date range ${input.fromSailDate} to ${input.toSailDate}`));
    if (input.shipCodes && input.shipCodes.length > 0) {
        await (0, throttle_1.scheduleAction)(limiter, () => page.act(`filter to only the following ship codes: ${input.shipCodes?.join(", ")}`));
    }
    const extracted = await (0, throttle_1.scheduleAction)(limiter, () => page.extract({
        instruction: "extract every visible sailing card with shipCode, shipName, sailDate (YYYY-MM-DD), packageCode, duration, packageDescription, regionCode, subRegionCode",
        schema: sailingScrapeSchema,
    }));
    const sailings = extracted.sailings.map((s) => ({ ...s, brandCode: input.brandCode }));
    if (sailings.length === 0) {
        throw new errors_1.EmptyResultsError();
    }
    return sailings;
}
//# sourceMappingURL=sailing-package.js.map