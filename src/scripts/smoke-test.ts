import { addMonths, formatISO } from "date-fns";

import { sailingPackageResponseSchema } from "@/api/schemas/sailing-package";
import { config } from "@/config";
import { getLogger } from "@/lib/logging";
import { getSailingPackages } from "@/services/sailing-catalog";

const logger = getLogger({ name: "scripts/smoke-test" });

/**
 * Task 12 — daily smoke test. Runs one fixed `sailing-package` query
 * against the live scraper and asserts the Zod schema parses the
 * response. Exits non-zero on failure so a GitHub Actions cron turns
 * it into a deploy-gate signal.
 *
 * Uses the service layer directly — no HTTP round-trip — so we test
 * the full stack (scraper → service → VPS shape) but skip auth.
 */
async function main(): Promise<void> {
  if (!config.scraper.steelApiKey || !config.scraper.anthropicApiKey) {
    logger.warn("smoke test: STEEL_API_KEY or ANTHROPIC_API_KEY missing — cannot drive scraper");
    process.exit(2);
  }

  const now = new Date();
  const to = addMonths(now, 3);
  const request = {
    brandCode: "R",
    fromSailDate: formatISO(now, { representation: "date" }),
    toSailDate: formatISO(to, { representation: "date" }),
    includeTourPackages: false,
  };

  logger.info(
    `smoke test: sailing-package brand=R from ${request.fromSailDate} to ${request.toSailDate}`
  );

  try {
    const response = await getSailingPackages(request);
    const parsed = sailingPackageResponseSchema.safeParse(response);
    if (!parsed.success) {
      logger.error(
        `smoke test failed: schema mismatch — ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`
      );
      process.exit(1);
    }
    logger.info(
      `smoke test passed: ${parsed.data.sailingPackages.length} sailings; status=${parsed.data.status.httpStatus}`
    );
    process.exit(0);
  } catch (err) {
    logger.errorWithStack(err, "smoke test threw");
    process.exit(1);
  }
}

void main();
