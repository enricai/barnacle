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
    await runChangeDetection();
  });
  logger.info(`changes worker scheduled: ${config.workers.changesCron}`);
  return job;
}

export async function runChangeDetection(): Promise<void> {
  const now = new Date();
  const to = addDays(now, 60);
  const fromSailDate = formatISO(now, { representation: "date" });
  const toSailDate = formatISO(to, { representation: "date" });

  for (const brandCode of ["R", "C"]) {
    try {
      logger.info(`changes sweep: brand=${brandCode} ${fromSailDate}..${toSailDate}`);
      await getSailingPackages({
        brandCode,
        fromSailDate,
        toSailDate,
        includeTourPackages: false,
      });
    } catch (err) {
      logger.warn(`changes sweep failed for brand=${brandCode}: ${String(err)}`);
    }
  }
}
