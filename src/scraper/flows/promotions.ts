import { z } from "zod";

import { getLogger } from "@/lib/logging";
import { EmptyResultsError } from "@/scraper/errors";
import type { BrowserSession } from "@/scraper/session";
import { scheduleAction } from "@/scraper/throttle";

const logger = getLogger({ name: "scraper/flows/promotions" });

export interface PromotionFlowInput {
  brand: string;
  currencyCodes: readonly string[];
  marketCountryCode?: string;
}

const promotionScrapeSchema = z.object({
  promotions: z.array(
    z.object({
      id: z.string(),
      shortDescription: z.string().optional(),
      startDate: z.string().optional(),
      endDate: z.string().optional(),
      refundableType: z.string().optional(),
      typeCode: z.string().optional(),
    })
  ),
});

export type PromotionScrapeResult = z.infer<typeof promotionScrapeSchema>["promotions"];

/**
 * Drives the RC promotions listing page and extracts live promotions.
 * This flow intentionally returns a loose shape — the service layer
 * normalizes into VPS's promotion-details response, filling defaults
 * for `sailingRestricted`/`categoryRestricted`/etc when not observable.
 */
export async function scrapePromotions(
  session: BrowserSession,
  input: PromotionFlowInput
): Promise<PromotionScrapeResult> {
  const { stagehand, limiter } = session;
  const page = stagehand.page;

  logger.info(
    `scraping promotions: brand=${input.brand} currencies=${input.currencyCodes.join(",")}`
  );

  await scheduleAction(limiter, () => page.goto("https://www.royalcaribbean.com/cruise-deals"));

  if (input.marketCountryCode) {
    await scheduleAction(limiter, () =>
      page.act(`switch the site market/country to ${input.marketCountryCode}`)
    );
  }

  const extracted = await scheduleAction(limiter, () =>
    page.extract({
      instruction:
        "extract every currently active promotion with its id/code, shortDescription, startDate and endDate (ISO or YYYY-MM-DD), refundableType, typeCode",
      schema: promotionScrapeSchema,
    })
  );

  if (extracted.promotions.length === 0) {
    throw new EmptyResultsError();
  }

  return extracted.promotions;
}
