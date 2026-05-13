import { Cron } from "croner";
import { addMonths, formatISO } from "date-fns";

import { config } from "@/config";
import { getLogger } from "@/lib/logging";
import { getSailingPackages } from "@/services/sailing-catalog";

const logger = getLogger({ name: "workers/refresh" });

/**
 * Daily full refresh worker. Drives a baseline `sailing-package` scrape
 * for each supported brand across a rolling forward window so the
 * snapshot table stays warm and the delta endpoints have data to diff
 * against.
 *
 * Why croner: simple, accurate, maintained, zero-dep, handles DST and
 * timezones correctly out of the box.
 */
export function startRefreshWorker(): Cron | null {
  if (!config.workers.enabled) {
    logger.info("workers disabled by config; refresh job not scheduled");
    return null;
  }

  const job = new Cron(config.workers.refreshCron, { name: "refresh" }, async () => {
    await runRefresh();
  });
  logger.info(`refresh worker scheduled: ${config.workers.refreshCron}`);
  return job;
}

/**
 * Exposed so operators can trigger an ad-hoc refresh via the smoke-test
 * script or admin tooling.
 */
export async function runRefresh(): Promise<void> {
  const now = new Date();
  const to = addMonths(now, 12);
  const fromSailDate = formatISO(now, { representation: "date" });
  const toSailDate = formatISO(to, { representation: "date" });

  for (const brandCode of ["R", "C"]) {
    try {
      logger.info(`refresh: brand=${brandCode} ${fromSailDate}..${toSailDate}`);
      await getSailingPackages({
        brandCode,
        fromSailDate,
        toSailDate,
        includeTourPackages: false,
      });
    } catch (err) {
      logger.warn(`refresh failed for brand=${brandCode}: ${String(err)}`);
    }
  }
}
