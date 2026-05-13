import { z } from "zod";

import { getLogger } from "@/lib/logging";
import { EmptyResultsError } from "@/scraper/errors";
import type { BrowserSession } from "@/scraper/session";
import { scheduleAction } from "@/scraper/throttle";

const logger = getLogger({ name: "scraper/flows/sailing-package" });

/**
 * Input shape derived from VPS's sailing-package request. Flows accept
 * the parsed request body verbatim — no mapping layer.
 */
export interface SailingPackageFlowInput {
  brandCode: string;
  fromSailDate: string;
  toSailDate: string;
  shipCodes?: string[];
  includeTourPackages?: boolean;
}

const sailingScrapeSchema = z.object({
  sailings: z.array(
    z.object({
      brandCode: z.string(),
      shipCode: z.string(),
      shipName: z.string().optional(),
      sailDate: z.string(),
      packageCode: z.string(),
      duration: z.number().int(),
      packageDescription: z.string().optional(),
      regionCode: z.string().optional(),
      subRegionCode: z.string().optional(),
    })
  ),
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
export async function scrapeSailingPackages(
  session: BrowserSession,
  input: SailingPackageFlowInput
): Promise<z.infer<typeof sailingScrapeSchema>["sailings"]> {
  const { stagehand, limiter } = session;
  const page = stagehand.page;

  logger.info(
    `scraping sailings: brand=${input.brandCode} window=${input.fromSailDate}..${input.toSailDate} ships=${(input.shipCodes ?? []).join(",") || "any"}`
  );

  await scheduleAction(limiter, () => page.goto("https://www.royalcaribbean.com/cruises"));

  await scheduleAction(limiter, () =>
    page.act(
      `apply the cruise search filter for departure date range ${input.fromSailDate} to ${input.toSailDate}`
    )
  );

  if (input.shipCodes && input.shipCodes.length > 0) {
    await scheduleAction(limiter, () =>
      page.act(`filter to only the following ship codes: ${input.shipCodes?.join(", ")}`)
    );
  }

  const extracted = await scheduleAction(limiter, () =>
    page.extract({
      instruction:
        "extract every visible sailing card with shipCode, shipName, sailDate (YYYY-MM-DD), packageCode, duration, packageDescription, regionCode, subRegionCode",
      schema: sailingScrapeSchema,
    })
  );

  const sailings = extracted.sailings.map((s) => ({ ...s, brandCode: input.brandCode }));
  if (sailings.length === 0) {
    throw new EmptyResultsError();
  }

  return sailings;
}
