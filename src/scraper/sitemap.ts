import { getLogger } from "@/lib/logging";

const logger = getLogger({ name: "scraper/sitemap" });

/**
 * Royal Caribbean publishes an itineraries sitemap that lists every
 * public cruise package URL. Each URL encodes the `packageCode` at the
 * end — the SAME identifier VPS uses in its Sailing Package response.
 *
 * This lets us discover the full catalog WITHOUT a browser session,
 * bypassing the SPA /cruises search UI entirely. The sitemap is
 * updated by RC on a near-daily cadence and is robots-allowed.
 *
 * Verified via `curl` on 2026-05-12 — see `docs/rc-recon.md`.
 */

const ITINERARY_SITEMAP_URL = "https://www.royalcaribbean.com/sitemap/sitemap_itineraries.xml";

export interface SitemapItineraryEntry {
  url: string;
  packageCode: string;
  shipCode: string;
  /** e.g. "3-night-bahamas-getaway-cruise-from-fort-lauderdale-on-jewel". */
  slug: string;
  /** e.g. 3 — extracted from the "{N}-night" prefix of the slug. */
  durationNights: number | undefined;
}

/**
 * Parses the packageCode out of an RC itinerary URL. Format:
 *   /itinerary/{slug}-{packageCode}
 * Where packageCode is an uppercase alphanumeric block (6–8 chars)
 * whose first two chars are the ship code (e.g. "JW3BH224",
 * "OV03X039", "HM2BH024").
 */
export function parseItineraryUrl(url: string): SitemapItineraryEntry | null {
  const match = url.match(
    /\/itinerary\/(?<slug>[a-z0-9-]+?)-(?<packageCode>[A-Z]{2}[A-Z0-9]{4,8})$/
  );
  if (!match?.groups) return null;
  const slug = match.groups.slug ?? "";
  const packageCode = match.groups.packageCode ?? "";
  const shipCode = packageCode.slice(0, 2);
  const durationMatch = slug.match(/^(\d+)-night/);
  const durationNights = durationMatch?.[1] ? Number.parseInt(durationMatch[1], 10) : undefined;
  return { url, packageCode, shipCode, slug, durationNights };
}

/**
 * Fetches and parses the RC itineraries sitemap. Returns one entry per
 * `<loc>` URL. No browser needed — plain fetch + regex against the XML.
 *
 * The full sitemap is ~1000-2000 entries; we consume it in one request
 * and hold the parsed list in memory. Callers should cache the result
 * (e.g. once per refresh worker tick) rather than re-fetching per
 * request.
 */
export async function fetchSitemapItineraries(
  url: string = ITINERARY_SITEMAP_URL
): Promise<SitemapItineraryEntry[]> {
  logger.info(`fetching itinerary sitemap from ${url}`);
  const response = await fetch(url, {
    headers: {
      "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
    },
  });
  if (!response.ok) {
    throw new Error(`itinerary sitemap fetch failed: ${response.status} ${response.statusText}`);
  }
  const xml = await response.text();
  return parseSitemapXml(xml);
}

/**
 * Extracts `<loc>` URLs from a sitemap XML string and parses each. Any
 * URL that doesn't match the itinerary pattern is skipped — the
 * sitemap occasionally contains non-itinerary links (category pages,
 * etc.) that we ignore rather than throw on.
 */
export function parseSitemapXml(xml: string): SitemapItineraryEntry[] {
  const out: SitemapItineraryEntry[] = [];
  const matches = xml.matchAll(/<loc>([^<]+)<\/loc>/g);
  for (const m of matches) {
    const url = m[1]?.trim();
    if (!url) continue;
    const parsed = parseItineraryUrl(url);
    if (parsed) out.push(parsed);
  }
  return out;
}
