import { Cron } from "croner";
import { addDays, formatISO } from "date-fns";

import { config } from "@/config";
import { getLogger } from "@/lib/logging";
import { getSailingPackages } from "@/services/sailing-catalog";

const logger = getLogger({ name: "workers/changes" });

/**
 * Hourly change-detection worker. Mirrors RC VPS's 60-minute trickle
 * update cadence. On each tick it rescrapes a short forward window and
 * the snapshot writes power the three delta endpoints.
 *
 * We intentionally keep the sailing-level rescrape scope small (next
 * 60 days) to cap Steel session cost; operators tune this via
 * `CHANGES_CRON` and the worker's own logic.
 */
export function startChangesWorker(): Cron | null {
  if (!config.workers.enabled) {
    logger.info("workers disabled by config; changes job not scheduled");
    return null;
  }

  const job = new Cron(config.workers.changesCron, { name: "changes" }, async () => {
    try {
      await runChangeDetection();
    } catch (err) {
      // Last-line-of-defense around the per-brand try/catches already in
      // runChangeDetection — if the sweep-summary log or any future
      // top-level code throws, we want the scheduler to survive and
      // emit an ops signal rather than silently dying between ticks.
      logger.warn(`changes tick threw unexpectedly: ${String(err)}`);
    }
  });
  logger.info(`changes worker scheduled: ${config.workers.changesCron}`);
  return job;
}

export async function runChangeDetection(): Promise<void> {
  const now = new Date();
  const to = addDays(now, 60);
  const fromSailDate = formatISO(now, { representation: "date" });
  const toSailDate = formatISO(to, { representation: "date" });
  const sweepStart = Date.now();
  let ok = 0;
  let failed = 0;

  for (const brandCode of ["R", "C"]) {
    const brandStart = Date.now();
    try {
      logger.info(`changes sweep: brand=${brandCode} ${fromSailDate}..${toSailDate}`);
      const response = await getSailingPackages({
        brandCode,
        fromSailDate,
        toSailDate,
        includeTourPackages: false,
      });
      ok += 1;
      logger.info(
        `changes sweep succeeded: brand=${brandCode} sailings=${response.sailingPackages.length} elapsedMs=${Date.now() - brandStart}`
      );
    } catch (err) {
      failed += 1;
      logger.warn(
        `changes sweep failed for brand=${brandCode} elapsedMs=${Date.now() - brandStart}: ${String(err)}`
      );
    }
  }
  logger.info(
    `changes sweep complete: ok=${ok} failed=${failed} elapsedMs=${Date.now() - sweepStart}`
  );
}
