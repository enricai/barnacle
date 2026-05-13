import { addMonths, formatISO } from "date-fns";

import {
  type SailingPackageRequest,
  sailingPackageResponseSchema,
} from "@/api/schemas/sailing-package";
import { config } from "@/config";
import { getLogger } from "@/lib/logging";
import { fetchSailingPackagesViaGraphql } from "@/scraper/flows/graphql-catalog";
import { scrapeSailingPackages } from "@/scraper/flows/sailing-package";
import { runWithSession } from "@/scraper/pool";

const logger = getLogger({ name: "scripts/smoke-test" });

/**
 * Task 12 — daily smoke test. Runs one fixed `sailing-package` query
 * through the direct-HTTP GraphQL catalog flow and asserts the Zod
 * schema parses the response. Exits non-zero on failure so a GitHub
 * Actions cron turns it into a deploy-gate signal.
 *
 * Browser-free: the GraphQL flow needs no Steel session or Anthropic
 * key, so the smoke runs in any environment that can reach
 * royalcaribbean.com. Steel-backed fallbacks remain exercised by live
 * traffic and the service-layer tests; the smoke is specifically for
 * the hot path that serves production requests.
 *
 * Success envelope shape matches the sailing-package schema exactly
 * so any drift in RC's GraphQL contract surfaces here before it
 * reaches clients.
 */
async function main(): Promise<void> {
  if (!config.scraper.steelApiKey || !config.scraper.anthropicApiKey) {
    logger.info(
      "smoke test: Steel/Anthropic keys not set — smoke still runs via GraphQL (browser-free)"
    );
  }

  const now = new Date();
  const to = addMonths(now, 3);
  const fromSailDate = formatISO(now, { representation: "date" });
  const toSailDate = formatISO(to, { representation: "date" });

  logger.info(`smoke test: sailing-package brand=R from ${fromSailDate} to ${toSailDate}`);

  try {
    const sailings = await fetchSailingPackagesViaGraphql({
      brandCode: "R",
      fromSailDate,
      toSailDate,
      includeTourPackages: false,
    });

    // Build the same envelope getSailingPackages would return so the
    // smoke asserts the response schema, not just the scraper output.
    const response = {
      status: {
        httpStatus: "OK",
        dateTime: formatISO(new Date()),
        details: [],
      },
      sailingPackages: sailings,
    };

    const parsed = sailingPackageResponseSchema.safeParse(response);
    if (!parsed.success) {
      logger.error(
        `smoke test failed: schema mismatch — ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`
      );
      process.exit(1);
    }

    if (parsed.data.sailingPackages.length === 0) {
      logger.warn(
        "smoke test: 0 sailings returned — schema-valid but suspicious for a 3-month window"
      );
      process.exit(1);
    }

    // sailDate must fall within the requested window for at least one
    // result. Cheap parity check that RC's filter logic still works.
    const inWindow = parsed.data.sailingPackages.filter(
      (s) => s.sailDate >= fromSailDate && s.sailDate <= toSailDate
    );
    if (inWindow.length === 0) {
      const sample = parsed.data.sailingPackages
        .slice(0, 3)
        .map((s) => s.sailDate)
        .join(", ");
      logger.error(
        `smoke test failed: no sailings within ${fromSailDate}..${toSailDate}, got dates like ${sample}`
      );
      process.exit(1);
    }

    // The top-level identity fields — brandCode, shipCode, packageCode,
    // duration — must be populated on every sailing. A silent drift
    // that dropped any of these would break VPS parity for downstream
    // price-change matching, so we assert all-or-nothing presence
    // rather than "at least one" (which would hide a partial regression).
    const missingKey = parsed.data.sailingPackages.find(
      (s) => !s.shipCode || !s.packageCode || typeof s.duration !== "number"
    );
    if (missingKey) {
      logger.error(
        `smoke test failed: sailing missing identity field — ${JSON.stringify({
          shipCode: missingKey.shipCode,
          packageCode: missingKey.packageCode,
          duration: missingKey.duration,
        })}`
      );
      process.exit(1);
    }

    // At least one sailing must have a populated sailingItinerary.schedule.
    // The GraphQL catalog flow projects RC's `days[].ports[]` tree into
    // VPS schedule entries; a regression that dropped that mapping would
    // leave every sailing with no port-by-port detail, which breaks VPS
    // parity for clients that render itineraries.
    const withItinerary = parsed.data.sailingPackages.filter(
      (s) => (s.sailingItinerary?.schedule?.length ?? 0) > 0
    );
    if (withItinerary.length === 0) {
      logger.error(
        "smoke test failed: every sailing has an empty sailingItinerary.schedule — likely a contract change or mapping regression"
      );
      process.exit(1);
    }

    logger.info(
      `smoke test passed: ${parsed.data.sailingPackages.length} sailings; ${inWindow.length} in-window; ${withItinerary.length} with itineraries`
    );

    // Opt-in Stagehand fallback smoke (TASKS.md Task 12 — "if Stagehand cache
    // needs to bust and prompts may need updating", this is the signal).
    // Gated by SMOKE_INCLUDE_FALLBACK=true AND by the presence of both Steel
    // and Anthropic keys, so the default CI cron stays browser-free and
    // zero-cost. When enabled, this runs one real scrape through the session
    // pool and asserts the response still parses through the same schema.
    if (shouldRunFallbackSmoke()) {
      await runFallbackSmoke({
        brandCode: "R",
        fromSailDate,
        toSailDate,
        includeTourPackages: false,
      });
    }

    process.exit(0);
  } catch (err) {
    logger.errorWithStack(err, "smoke test threw");
    process.exit(1);
  }
}

function shouldRunFallbackSmoke(): boolean {
  if (process.env.SMOKE_INCLUDE_FALLBACK !== "true") return false;
  if (!config.scraper.steelApiKey || !config.scraper.anthropicApiKey) {
    logger.warn(
      "SMOKE_INCLUDE_FALLBACK=true but STEEL_API_KEY/ANTHROPIC_API_KEY missing — skipping fallback smoke"
    );
    return false;
  }
  return true;
}

async function runFallbackSmoke(request: SailingPackageRequest): Promise<void> {
  logger.info("smoke test (fallback): running Stagehand scrape once via session pool");
  const sailings = await runWithSession((session) => scrapeSailingPackages(session, request));
  const response = {
    status: {
      httpStatus: "OK",
      dateTime: formatISO(new Date()),
      details: [],
    },
    sailingPackages: sailings,
  };
  const parsed = sailingPackageResponseSchema.safeParse(response);
  if (!parsed.success) {
    logger.error(
      `smoke test (fallback) failed: schema mismatch — ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`
    );
    process.exit(1);
  }
  logger.info(
    `smoke test (fallback) passed: ${parsed.data.sailingPackages.length} sailings via Stagehand`
  );
}

void main();
