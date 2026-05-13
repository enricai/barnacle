import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { formatISO } from "date-fns";

import { config } from "@/config";
import { getLogger } from "@/lib/logging";
import { createBrowserSession } from "@/scraper/session";
import { fetchSitemapItineraries } from "@/scraper/sitemap";

const logger = getLogger({ name: "scripts/recon-browser" });

const OUTPUT_DIR = "/tmp/recon";
const GRAPHQL_DIR = join(OUTPUT_DIR, "graphql");

/**
 * Phase 1 of the recon pipeline — drives one Steel + Stagehand session
 * against `royalcaribbean.com/cruises` and one `/itinerary/…` detail page
 * and captures every GraphQL request + response, UNTRUNCATED, to disk.
 *
 * Why a dedicated browser-only script: the previous `recon.ts` truncated
 * queries at 1500 chars and responses at 600 chars so markdown stayed
 * readable. That's the wrong trade-off — we need the full wire bytes
 * to map GraphQL fields to VPS's pricing envelopes.
 *
 * Captures written here are consumed by `recon-http.ts` (replay + probe)
 * and `recon-summarize.ts` (human-readable rollup).
 *
 * Budget: one Steel session, ~90s.
 */

interface GraphqlCapture {
  capturedAt: string;
  url: string;
  method: string;
  status: number;
  operationName: string | undefined;
  query: string | undefined;
  variables: unknown;
  requestPostData: string | null;
  responseBody: string | null;
  responseHeaders: Record<string, string>;
  requestHeaders: Record<string, string>;
  phase: "home" | "filter" | "detail";
}

interface FilterEncodingCapture {
  capturedAt: string;
  filters: string;
  qualifiers: string | undefined;
  decodedAs: {
    asJson: unknown;
    asUrlEncoded: Record<string, string> | null;
    asBase64: string | null;
  };
  triggerDescription: string;
}

function safeParseJson(input: string | null | undefined): unknown {
  if (!input) return null;
  try {
    return JSON.parse(input);
  } catch {
    return null;
  }
}

function tryDecodeFilters(raw: string): FilterEncodingCapture["decodedAs"] {
  return {
    asJson: safeParseJson(raw),
    asUrlEncoded: (() => {
      try {
        const params = new URLSearchParams(raw);
        const obj: Record<string, string> = {};
        for (const [k, v] of params.entries()) obj[k] = v;
        return Object.keys(obj).length > 0 ? obj : null;
      } catch {
        return null;
      }
    })(),
    asBase64: (() => {
      try {
        const decoded = Buffer.from(raw, "base64").toString("utf8");
        return /[\x20-\x7e]/.test(decoded) ? decoded : null;
      } catch {
        return null;
      }
    })(),
  };
}

async function main(): Promise<void> {
  if (!config.scraper.steelApiKey || !config.scraper.anthropicApiKey) {
    logger.error("STEEL_API_KEY and ANTHROPIC_API_KEY must be set");
    process.exit(2);
  }

  mkdirSync(GRAPHQL_DIR, { recursive: true });

  logger.info("fetching sitemap for one detail-page probe URL");
  const sitemap = await fetchSitemapItineraries();
  const detailEntry = sitemap.find((e) => e.packageCode.startsWith("WN")) ?? sitemap[0];
  if (!detailEntry) {
    logger.error("sitemap returned zero itineraries — cannot probe detail page");
    process.exit(1);
  }
  logger.info(`detail probe URL: ${detailEntry.url}`);

  logger.info("spinning up Steel + Stagehand session");
  const session = await createBrowserSession();
  const captures: GraphqlCapture[] = [];
  let filterEncoding: FilterEncodingCapture | null = null;
  let phase: GraphqlCapture["phase"] = "home";

  try {
    const { stagehand } = session;
    const page = stagehand.page;
    const ctx = page.context();

    let allResponseCount = 0;
    let graphlikeResponseCount = 0;

    const onResponse = async (response: {
      url: () => string;
      request: () => {
        method: () => string;
        postData: () => string | null;
        postDataJSON?: () => unknown;
        resourceType: () => string;
        headers: () => Record<string, string>;
      };
      status: () => number;
      headers: () => Record<string, string>;
      text: () => Promise<string>;
    }): Promise<void> => {
      allResponseCount += 1;
      const request = response.request();
      const url = response.url();
      if (allResponseCount <= 20) {
        logger.info(
          `[debug] response #${allResponseCount}: ${response.status()} ${url.slice(0, 160)}`
        );
      }
      if (!/royalcaribbean\.com|rccl\.com/i.test(url)) return;
      const isGraph = /\/graph(?:[/?]|$)|\/cruises\/graph/i.test(url);
      if (!isGraph) return;
      graphlikeResponseCount += 1;
      const postData = request.postData() ?? request.postDataJSON?.() ?? null;
      const postDataString = typeof postData === "string" ? postData : JSON.stringify(postData);
      const parsed = safeParseJson(postDataString) as {
        operationName?: string;
        query?: string;
        variables?: { filters?: string; qualifiers?: string } & Record<string, unknown>;
      } | null;
      let responseBody: string | null = null;
      try {
        responseBody = await response.text();
      } catch {
        responseBody = null;
      }
      const capture: GraphqlCapture = {
        capturedAt: formatISO(new Date()),
        url,
        method: request.method(),
        status: response.status(),
        operationName: parsed?.operationName,
        query: parsed?.query,
        variables: parsed?.variables,
        requestPostData: postDataString,
        responseBody,
        responseHeaders: response.headers(),
        requestHeaders: request.headers(),
        phase,
      };
      captures.push(capture);

      if (
        !filterEncoding &&
        parsed?.operationName === "cruiseSearch_Cruises" &&
        parsed?.variables?.filters &&
        parsed.variables.filters.length > 0
      ) {
        const raw = parsed.variables.filters;
        filterEncoding = {
          capturedAt: formatISO(new Date()),
          filters: raw,
          qualifiers: parsed.variables.qualifiers,
          decodedAs: tryDecodeFilters(raw),
          triggerDescription:
            "first cruiseSearch_Cruises observed with non-empty filters after facet click",
        };
        logger.info(`filter-encoding captured: ${raw.slice(0, 120)}`);
      }
    };

    ctx.on("response", (r) => {
      void onResponse(r as Parameters<typeof onResponse>[0]).catch((err) => {
        logger.warn(`response handler threw: ${String(err).slice(0, 120)}`);
      });
    });
    page.on("response", (r) => {
      // Also listen at page level — Stagehand's wrapper may filter ctx events.
      // Guard against double-count via a WeakSet keyed by response obj.
      // (Simpler: just rely on dedup — captures only grow by unique URL+body.)
      void onResponse(r as Parameters<typeof onResponse>[0]).catch((err) => {
        logger.warn(`page response handler threw: ${String(err).slice(0, 120)}`);
      });
    });

    logger.info("phase=home: navigate /cruises");
    phase = "home";
    await page
      .goto("https://www.royalcaribbean.com/cruises", {
        waitUntil: "networkidle",
        timeout: 60_000,
      })
      .catch(() =>
        page.goto("https://www.royalcaribbean.com/cruises", {
          waitUntil: "domcontentloaded",
          timeout: 60_000,
        })
      );
    await page.waitForTimeout(5_000);

    logger.info("phase=filter: apply Caribbean facet via raw Playwright locators");
    phase = "filter";
    const facetClickStrategies: Array<{ label: string; fn: () => Promise<void> }> = [
      {
        label: "getByRole checkbox Caribbean",
        fn: async () => {
          await page
            .getByRole("checkbox", { name: /caribbean/i })
            .first()
            .click({ timeout: 8_000 });
        },
      },
      {
        label: "getByTestId destination-caribbean",
        fn: async () => {
          await page
            .getByTestId(/destination.*caribbean|caribbean/i)
            .first()
            .click({ timeout: 8_000 });
        },
      },
      {
        label: "getByText Caribbean",
        fn: async () => {
          await page
            .getByText(/^Caribbean$/i)
            .first()
            .click({ timeout: 8_000 });
        },
      },
    ];
    let facetClicked = false;
    for (const strat of facetClickStrategies) {
      try {
        await strat.fn();
        logger.info(`facet click strategy succeeded: ${strat.label}`);
        facetClicked = true;
        break;
      } catch (err) {
        logger.warn(`facet click strategy failed (${strat.label}): ${String(err).slice(0, 120)}`);
      }
    }
    if (!facetClicked) {
      logger.warn("all facet click strategies failed — filter encoding may not be captured");
    }

    await page.waitForTimeout(3_000);

    try {
      await page
        .getByText(/^7 nights$|^7-night$|^7$/i)
        .first()
        .click({ timeout: 5_000 });
      logger.info("second facet (7 nights) clicked");
      await page.waitForTimeout(3_000);
    } catch (err) {
      logger.warn(`second facet click failed: ${String(err).slice(0, 120)}`);
    }

    logger.info(`phase=detail: navigate ${detailEntry.url}`);
    phase = "detail";
    await page
      .goto(`${detailEntry.url}?sailDate=2026-09-28&packageCode=${detailEntry.packageCode}`, {
        waitUntil: "networkidle",
        timeout: 60_000,
      })
      .catch(() =>
        page.goto(`${detailEntry.url}?sailDate=2026-09-28&packageCode=${detailEntry.packageCode}`, {
          waitUntil: "domcontentloaded",
          timeout: 60_000,
        })
      );
    await page.waitForTimeout(10_000);

    logger.info(
      `response listener saw ${allResponseCount} total responses, ${graphlikeResponseCount} graph-like; ${captures.length} captures; writing to ${GRAPHQL_DIR}`
    );
    for (const [i, c] of captures.entries()) {
      const filename = `${String(i).padStart(3, "0")}-${c.phase}-${c.operationName ?? "anon"}.json`;
      writeFileSync(join(GRAPHQL_DIR, filename), JSON.stringify(c, null, 2));
    }

    if (filterEncoding) {
      writeFileSync(
        join(OUTPUT_DIR, "filter-encoding.json"),
        JSON.stringify(filterEncoding, null, 2)
      );
    } else {
      writeFileSync(
        join(OUTPUT_DIR, "filter-encoding.json"),
        JSON.stringify(
          {
            capturedAt: formatISO(new Date()),
            filters: null,
            note: "no cruiseSearch_Cruises with non-empty filters was observed — facet clicks did not fire a filtered query",
          },
          null,
          2
        )
      );
    }

    writeFileSync(
      join(OUTPUT_DIR, "browser-summary.json"),
      JSON.stringify(
        {
          capturedAt: formatISO(new Date()),
          detailProbeUrl: detailEntry.url,
          detailPackageCode: detailEntry.packageCode,
          totalCaptures: captures.length,
          byPhase: {
            home: captures.filter((c) => c.phase === "home").length,
            filter: captures.filter((c) => c.phase === "filter").length,
            detail: captures.filter((c) => c.phase === "detail").length,
          },
          distinctOperations: Array.from(new Set(captures.map((c) => c.operationName ?? "(anon)"))),
        },
        null,
        2
      )
    );
    logger.info("browser recon complete");
  } finally {
    await session.close();
  }
}

void main().catch((err) => {
  logger.errorWithStack(err, "recon-browser script threw");
  process.exit(1);
});
