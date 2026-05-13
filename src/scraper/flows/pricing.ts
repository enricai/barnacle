import { z } from "zod";

import { getLogger } from "@/lib/logging";
import { EmptyResultsError } from "@/scraper/errors";
import type { BrowserSession } from "@/scraper/session";
import { scheduleAction } from "@/scraper/throttle";

const logger = getLogger({ name: "scraper/flows/pricing" });

/**
 * Narrow input — only the keys we need to drive the RC pricing UI for
 * a single sailing. Services pass the whole VPS pricing request and
 * flatten it down to this shape.
 */
export interface PricingFlowInput {
  brandCode: string;
  shipCode: string;
  sailDate: string;
  packageCode: string;
  occupancy: number;
  currencyCode: string;
  bookingTypeCode: string;
}

const pricingScrapeSchema = z.object({
  cabinOptions: z.array(
    z.object({
      stateroomCategoryCode: z.string(),
      stateroomSuperCategory: z.string().optional(),
      stateroomTypeCode: z.string().optional(),
      refundableFareFlag: z.boolean().optional(),
      accessibleStateroomExistFlag: z.boolean().optional(),
      pricePerGuest: z.number(),
      netCruiseFareAmount: z.number().optional(),
      taxesAndFeesAmount: z.number().optional(),
      originalAmount: z.number().optional(),
      leadPromotionShortDescription: z.string().optional(),
    })
  ),
});

export type PricingScrapeResult = z.infer<typeof pricingScrapeSchema>["cabinOptions"];

/**
 * Drives the per-sailing pricing page and extracts cabin-level pricing.
 * Returns one row per stateroom category; the service layer folds these
 * into super-category / category / group response shapes.
 */
export async function scrapeSailingPricing(
  session: BrowserSession,
  input: PricingFlowInput
): Promise<PricingScrapeResult> {
  const { stagehand, limiter } = session;
  const page = stagehand.page;

  logger.info(
    `scraping pricing: ${input.shipCode} ${input.sailDate} ${input.packageCode} occ=${input.occupancy} cur=${input.currencyCode} type=${input.bookingTypeCode}`
  );

  const url =
    `https://www.royalcaribbean.com/cruise?shipCode=${encodeURIComponent(input.shipCode)}` +
    `&sailDate=${encodeURIComponent(input.sailDate)}&packageCode=${encodeURIComponent(input.packageCode)}`;
  await scheduleAction(limiter, () => page.goto(url));

  await scheduleAction(limiter, () =>
    page.act(
      `set guest count to ${input.occupancy} and currency to ${input.currencyCode}${
        input.bookingTypeCode === "G" ? " and apply the group booking context" : ""
      }`
    )
  );

  const extracted = await scheduleAction(limiter, () =>
    page.extract({
      instruction:
        "extract every cabin / stateroom category shown with stateroomCategoryCode, stateroomSuperCategory (I/O/B/D/A/C), stateroomTypeCode, refundableFareFlag, accessibleStateroomExistFlag, pricePerGuest, netCruiseFareAmount, taxesAndFeesAmount, originalAmount, leadPromotionShortDescription",
      schema: pricingScrapeSchema,
    })
  );

  if (extracted.cabinOptions.length === 0) {
    throw new EmptyResultsError();
  }

  return extracted.cabinOptions;
}
