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
    try {
      await runRefresh();
    } catch (err) {
      // Last-line-of-defense around the per-brand try/catches already in
      // runRefresh — if the sweep-summary log or any future top-level
      // code throws, we want the scheduler to survive and emit an ops
      // signal rather than silently dying between ticks.
      logger.warn(`refresh tick threw unexpectedly: ${String(err)}`);
    }
  });
  logger.info(`refresh worker scheduled: ${config.workers.refreshCron}`);
  return job;
}

/**
 * Exposed so operators can trigger an ad-hoc refresh via the smoke-test
 * script or admin tooling. Emits a start log per brand, a success log
 * with sailing count on completion, and an aggregate sweep summary —
 * silent-success is indistinguishable from silent-hung in an alerting
 * rule, so every tick needs an observable outcome.
 */
export async function runRefresh(): Promise<void> {
  const now = new Date();
  const to = addMonths(now, 12);
  const fromSailDate = formatISO(now, { representation: "date" });
  const toSailDate = formatISO(to, { representation: "date" });
  const sweepStart = Date.now();
  let ok = 0;
  let failed = 0;

  for (const brandCode of ["R", "C"]) {
    const brandStart = Date.now();
    try {
      logger.info(`refresh: brand=${brandCode} ${fromSailDate}..${toSailDate}`);
      const response = await getSailingPackages({
        brandCode,
        fromSailDate,
        toSailDate,
        includeTourPackages: false,
      });
      ok += 1;
      logger.info(
        `refresh succeeded: brand=${brandCode} sailings=${response.sailingPackages.length} elapsedMs=${Date.now() - brandStart}`
      );
    } catch (err) {
      failed += 1;
      logger.warn(
        `refresh failed for brand=${brandCode} elapsedMs=${Date.now() - brandStart}: ${String(err)}`
      );
    }
  }
  logger.info(
    `refresh sweep complete: ok=${ok} failed=${failed} elapsedMs=${Date.now() - sweepStart}`
  );
}
