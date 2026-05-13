"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const date_fns_1 = require("date-fns");
const sailing_package_1 = require("@/api/schemas/sailing-package");
const config_1 = require("@/config");
const logging_1 = require("@/lib/logging");
const sailing_catalog_1 = require("@/services/sailing-catalog");
const logger = (0, logging_1.getLogger)({ name: "scripts/smoke-test" });
/**
 * Task 12 — daily smoke test. Runs one fixed `sailing-package` query
 * against the live scraper and asserts the Zod schema parses the
 * response. Exits non-zero on failure so a GitHub Actions cron turns
 * it into a deploy-gate signal.
 *
 * Uses the service layer directly — no HTTP round-trip — so we test
 * the full stack (scraper → service → VPS shape) but skip auth.
 */
async function main() {
    if (!config_1.config.scraper.steelApiKey || !config_1.config.scraper.anthropicApiKey) {
        logger.warn("smoke test: STEEL_API_KEY or ANTHROPIC_API_KEY missing — cannot drive scraper");
        process.exit(2);
    }
    const now = new Date();
    const to = (0, date_fns_1.addMonths)(now, 3);
    const request = {
        brandCode: "R",
        fromSailDate: (0, date_fns_1.formatISO)(now, { representation: "date" }),
        toSailDate: (0, date_fns_1.formatISO)(to, { representation: "date" }),
        includeTourPackages: false,
    };
    logger.info(`smoke test: sailing-package brand=R from ${request.fromSailDate} to ${request.toSailDate}`);
    try {
        const response = await (0, sailing_catalog_1.getSailingPackages)(request);
        const parsed = sailing_package_1.sailingPackageResponseSchema.safeParse(response);
        if (!parsed.success) {
            logger.error(`smoke test failed: schema mismatch — ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
            process.exit(1);
        }
        logger.info(`smoke test passed: ${parsed.data.sailingPackages.length} sailings; status=${parsed.data.status.httpStatus}`);
        process.exit(0);
    }
    catch (err) {
        logger.errorWithStack(err, "smoke test threw");
        process.exit(1);
    }
}
void main();
//# sourceMappingURL=smoke-test.js.map