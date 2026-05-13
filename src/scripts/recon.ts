import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { formatISO } from "date-fns";
import { z } from "zod";

import { config } from "@/config";
import { getLogger } from "@/lib/logging";
import { createBrowserSession } from "@/scraper/session";

const logger = getLogger({ name: "scripts/recon" });

const OUTPUT_PATH = join(process.cwd(), "docs", "rc-recon-live.md");

/**
 * One-shot live reconnaissance of royalcaribbean.com/cruises.
 *
 * Drives a single Steel+Stagehand session, extracts every filter widget
 * with its options + data-testid, submits a tiny search, captures
 * pagination pattern + result-card fields, and watches the browser's
 * network traffic for XHR endpoints that might expose a direct JSON
 * API (bypassing the SPA entirely).
 *
 * Writes everything to `docs/rc-recon-live.md` as a dated appendix to
 * the manual recon doc. Safe to run multiple times — each run
 * overwrites its output file (separate from the hand-curated
 * `docs/rc-recon.md` so we don't clobber commentary).
 *
 * Budget: one Steel session, ~30-90 seconds of wall time.
 */

const filterWidgetsSchema = z.object({
  widgets: z.array(
    z.object({
      label: z.string(),
      kind: z.string().describe("single-select | multi-select | date | stepper | text | toggle"),
      dataTestId: z.string().optional(),
      placeholder: z.string().optional(),
      options: z.array(z.string()).optional(),
    })
  ),
  searchButton: z
    .object({
      label: z.string(),
      dataTestId: z.string().optional(),
    })
    .optional(),
});

const paginationProbeSchema = z.object({
  mechanism: z.enum(["next-button", "load-more", "infinite-scroll", "numbered-pages", "none"]),
  evidence: z.string(),
  triggerDataTestId: z.string().optional(),
});

const resultCardSchema = z.object({
  cards: z.array(
    z.object({
      shipName: z.string().optional(),
      sailDate: z.string().optional(),
      durationNights: z.number().int().optional(),
      departurePort: z.string().optional(),
      destinations: z.array(z.string()).optional(),
      startingPrice: z.string().optional(),
      priceCurrency: z.string().optional(),
      detailUrl: z.string().optional(),
      dataTestId: z.string().optional(),
    })
  ),
  sampleCardHtml: z.string().optional().describe("truncated HTML of one card for verification"),
});

interface NetworkHit {
  method: string;
  url: string;
  status: number;
  resourceType: string;
  contentType?: string;
  size?: number;
}

interface GraphqlCapture {
  url: string;
  operationName?: string;
  query?: string;
  variables?: unknown;
  responseBodyHead?: string;
}

function appendMd(content: string): void {
  appendFileSync(OUTPUT_PATH, `${content}\n`);
}

async function main(): Promise<void> {
  if (!config.scraper.steelApiKey || !config.scraper.anthropicApiKey) {
    logger.error("STEEL_API_KEY and ANTHROPIC_API_KEY must be set");
    process.exit(2);
  }

  // Reset the output file.
  writeFileSync(
    OUTPUT_PATH,
    `# Live RC Recon — auto-captured\n\nRun at ${formatISO(new Date())}\n\n`
  );

  logger.info("spinning up Steel + Stagehand session");
  const session = await createBrowserSession();
  const hits: NetworkHit[] = [];
  const graphqlHits: GraphqlCapture[] = [];

  try {
    const { stagehand } = session;
    const page = stagehand.page;

    // Stagehand's Page extends Playwright's Page (minus `on`/`screenshot`);
    // the BrowserContext still has the full Playwright event API.
    const ctx = page.context();
    ctx.on("response", async (response) => {
      const request = response.request();
      const url = response.url();
      if (!/royalcaribbean\.com|rccl\.com/i.test(url)) return;
      const resourceType = request.resourceType();
      if (resourceType === "image" || resourceType === "font" || resourceType === "stylesheet")
        return;
      const contentType = response.headers()["content-type"];
      hits.push({
        method: request.method(),
        url,
        status: response.status(),
        resourceType,
        contentType,
      });

      // Special-case GraphQL endpoints — capture request body + trimmed
      // response body so we can reconstruct a direct-HTTP catalog path
      // that bypasses Stagehand entirely for steady-state queries.
      if (/\/graph$/i.test(url) || /\/cruises\/graph$/i.test(url)) {
        try {
          const postData = request.postData() ?? "";
          let operationName: string | undefined;
          let query: string | undefined;
          let variables: unknown;
          try {
            const parsed = JSON.parse(postData) as {
              operationName?: string;
              query?: string;
              variables?: unknown;
            };
            operationName = parsed.operationName;
            query = parsed.query;
            variables = parsed.variables;
          } catch {
            // body may be non-JSON; ignore
          }
          let responseBodyHead: string | undefined;
          try {
            const text = await response.text();
            responseBodyHead = text.slice(0, 600);
          } catch {
            // body not retained by browser
          }
          graphqlHits.push({ url, operationName, query, variables, responseBodyHead });
        } catch {
          // shouldn't throw but defensive
        }
      }
    });

    logger.info("navigating to /cruises");
    await page
      .goto("https://www.royalcaribbean.com/cruises", { waitUntil: "networkidle", timeout: 60_000 })
      .catch(() => {
        // networkidle sometimes never settles on RC — fall back to domcontentloaded.
        return page.goto("https://www.royalcaribbean.com/cruises", {
          waitUntil: "domcontentloaded",
          timeout: 60_000,
        });
      });

    // Let any lazy hydration finish.
    await page.waitForTimeout(5_000);

    appendMd(`## /cruises filter widgets\n`);
    logger.info("extracting filter widgets");
    try {
      const widgets = await page.extract({
        instruction:
          "list every SEARCH / FILTER widget visible on the Royal Caribbean cruise-search page. For each widget capture its human-readable label, its kind (single-select | multi-select | date | stepper | text | toggle), its data-testid attribute if any, placeholder text if any, and every option label visible in a dropdown (up to 20 options).",
        schema: filterWidgetsSchema,
      });
      appendMd("```json");
      appendMd(JSON.stringify(widgets, null, 2));
      appendMd("```");
    } catch (err) {
      appendMd(`_Extract failed: ${String(err)}_`);
    }

    appendMd(`\n## Running a small search: Caribbean, Jun–Aug 2026, 2 guests\n`);
    logger.info("applying filters");
    for (const act of [
      "open the destination / region filter and select 'Caribbean'",
      "open the departure-date filter and set the range to June 2026 through August 2026",
      "open the guests filter and set it to 2 guests",
      "click the search / view results button to apply the filters",
    ]) {
      try {
        await page.act(act);
        await page.waitForTimeout(1_500);
      } catch (err) {
        appendMd(`- \`act\` failed: ${act} — ${String(err)}`);
      }
    }
    await page.waitForTimeout(4_000);

    appendMd(`\n## Pagination probe\n`);
    try {
      const pagination = await page.extract({
        instruction:
          "On this search-results page, determine how additional results are loaded. Choose exactly one mechanism: next-button (explicit Next button), load-more (Load More or Show More button), infinite-scroll (results append as you scroll to the bottom), numbered-pages (pagination dots 1 / 2 / 3 …), or none (all results rendered). Include the data-testid of any trigger element and a short description of the evidence you used.",
        schema: paginationProbeSchema,
      });
      appendMd("```json");
      appendMd(JSON.stringify(pagination, null, 2));
      appendMd("```");
    } catch (err) {
      appendMd(`_Extract failed: ${String(err)}_`);
    }

    appendMd(`\n## Sample result cards\n`);
    try {
      const cards = await page.extract({
        instruction:
          "Extract the first 5 cruise sailing cards visible on this results page. For each card capture: shipName, sailDate (ISO or 'Jun 15, 2026' style, preserve the site's format), durationNights as an integer, departurePort, destinations as a list, starting-price text, priceCurrency, detailUrl (the link the 'View Itinerary' / card click goes to), and the outer card's data-testid if any. Also return the raw outer HTML of the first card truncated to 400 characters.",
        schema: resultCardSchema,
      });
      appendMd("```json");
      appendMd(JSON.stringify(cards, null, 2));
      appendMd("```");
    } catch (err) {
      appendMd(`_Extract failed: ${String(err)}_`);
    }

    appendMd(`\n## Network hits (potentially useful XHR / JSON endpoints)\n`);
    const xhr = hits.filter(
      (h) =>
        h.resourceType === "xhr" ||
        h.resourceType === "fetch" ||
        (h.contentType && /json/i.test(h.contentType))
    );
    appendMd(
      `Observed **${xhr.length}** XHR/fetch/JSON responses (out of ${hits.length} total tracked):`
    );
    appendMd("");
    appendMd("| # | method | status | resourceType | content-type | url |");
    appendMd("|---|--------|--------|--------------|--------------|-----|");
    for (const [i, h] of xhr.slice(0, 50).entries()) {
      appendMd(
        `| ${i + 1} | ${h.method} | ${h.status} | ${h.resourceType} | ${h.contentType ?? ""} | ${h.url.slice(0, 180)} |`
      );
    }
    if (xhr.length > 50) appendMd(`\n_… and ${xhr.length - 50} more omitted_`);

    appendMd(`\n## GraphQL captures\n`);
    appendMd(
      `RC's search UI hits \`/graph\` and \`/cruises/graph\`. If we can reconstruct the queries, we can bypass Stagehand for steady-state catalog reads and only use the browser when JS-only features (auth, captcha-gated paths) block the HTTP path.\n`
    );
    appendMd(`Captured **${graphqlHits.length}** GraphQL exchanges:\n`);
    for (const [i, g] of graphqlHits.entries()) {
      appendMd(`### #${i + 1} ${g.operationName ?? "(no operationName)"} — ${g.url}`);
      if (g.query) {
        appendMd("```graphql");
        appendMd(g.query.slice(0, 1_500));
        appendMd("```");
      }
      if (g.variables !== undefined) {
        appendMd("**variables:**");
        appendMd("```json");
        appendMd(JSON.stringify(g.variables, null, 2).slice(0, 800));
        appendMd("```");
      }
      if (g.responseBodyHead) {
        appendMd("**response head:**");
        appendMd("```json");
        appendMd(g.responseBodyHead);
        appendMd("```");
      }
      appendMd("");
    }

    logger.info(
      `recon complete; wrote findings to ${OUTPUT_PATH}; tracked ${hits.length} network responses`
    );
  } finally {
    await session.close();
  }
}

void main().catch((err) => {
  logger.errorWithStack(err, "recon script threw");
  process.exit(1);
});
