/**
 * Stagehand browser fallback for the example site. Core's dispatch layer
 * invokes this automatically when executeHttp throws HttpSchemaError or
 * HttpBotChallengeError — the plugin never wires the fallback itself.
 *
 * Replace the act() steps below with the narrowest sequence of user actions
 * whose data you care about (Step 0 of the playbook). This file is what
 * recon-browser.ts executes automatically — the human-authored flow definition.
 */

import type { Stagehand } from "@browserbasehq/stagehand";
import { z } from "zod";

export interface ExampleBrowserResult {
  items: unknown[];
}

const ExampleBrowserResultSchema = z.object({
  items: z.array(z.unknown()),
});

/**
 * Drives the example site through a catalog search flow and returns the raw
 * data extracted by Stagehand. Intended as the browser fallback only — the
 * hot path in contract.ts is the production path.
 */
export async function runExampleBrowserFlow(
  stagehand: Stagehand,
  baseUrl: string,
  query: string
): Promise<ExampleBrowserResult> {
  const page = await stagehand.context.awaitActivePage();

  await page.goto(`${baseUrl}/catalog`, { waitUntil: "networkidle" });

  // Step 1 of the playbook flow: trigger the network traffic you care about.
  // In V3, act() and extract() live on stagehand directly, not on the page.
  await stagehand.act(`search for "${query}"`);

  // Step 2: open a result to trigger the detail-page query.
  await stagehand.act("open the first result");

  // extract() pulls structured data from the rendered DOM. For GraphQL targets
  // the network listener in recon-browser.ts already captured the raw API
  // response — use this only for SPAs that render data without a clean API.
  return stagehand.extract(
    "extract all visible result items as a list",
    ExampleBrowserResultSchema
  );
}
