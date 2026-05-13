import { describe, expect, it } from "vitest";

import { parseItineraryUrl, parseSitemapXml } from "@/scraper/sitemap";

describe("scraper/sitemap", () => {
  describe("parseItineraryUrl", () => {
    it("extracts packageCode + shipCode + duration from a real RC URL", () => {
      const entry = parseItineraryUrl(
        "https://www.royalcaribbean.com/itinerary/3-night-bahamas-getaway-cruise-from-fort-lauderdale-on-jewel-JW3BH224"
      );
      expect(entry).not.toBeNull();
      expect(entry?.packageCode).toBe("JW3BH224");
      expect(entry?.shipCode).toBe("JW");
      expect(entry?.durationNights).toBe(3);
      expect(entry?.slug).toBe("3-night-bahamas-getaway-cruise-from-fort-lauderdale-on-jewel");
    });

    it("handles ovation / harmony / navigator / spectrum / voyager / quantum prefixes", () => {
      const cases: Array<[string, string, string]> = [
        [
          "https://www.royalcaribbean.com/itinerary/3-night-ensenada-cruise-from-los-angeles-on-ovation-OV03X039",
          "OV03X039",
          "OV",
        ],
        [
          "https://www.royalcaribbean.com/itinerary/2-night-perfect-day-at-cococay-getaway-from-orlando-port-canaveral-on-harmony-HM2BH024",
          "HM2BH024",
          "HM",
        ],
        [
          "https://www.royalcaribbean.com/itinerary/3-night-penang-cruise-from-singapore-on-navigator-NV03I207",
          "NV03I207",
          "NV",
        ],
        [
          "https://www.royalcaribbean.com/itinerary/2-night-weekend-getaway-cruise-from-hong-kong-on-spectrum-SC02I142",
          "SC02I142",
          "SC",
        ],
        [
          "https://www.royalcaribbean.com/itinerary/3-night-ensenada-cruise-from-los-angeles-on-voyager-VY03X045",
          "VY03X045",
          "VY",
        ],
        [
          "https://www.royalcaribbean.com/itinerary/3-night-ensenada-cruise-from-los-angeles-on-quantum-QN03X035",
          "QN03X035",
          "QN",
        ],
      ];
      for (const [url, packageCode, shipCode] of cases) {
        const entry = parseItineraryUrl(url);
        expect(entry?.packageCode).toBe(packageCode);
        expect(entry?.shipCode).toBe(shipCode);
      }
    });

    it("returns null for URLs that are not itinerary pages", () => {
      expect(parseItineraryUrl("https://www.royalcaribbean.com/cruises")).toBeNull();
      expect(
        parseItineraryUrl("https://www.royalcaribbean.com/cruise-ships/jewel-of-the-seas")
      ).toBeNull();
      expect(parseItineraryUrl("")).toBeNull();
    });
  });

  describe("parseSitemapXml", () => {
    it("parses multiple <loc> entries and filters out non-itinerary URLs", () => {
      const xml = `<?xml version="1.0"?>
        <urlset>
          <url><loc>https://www.royalcaribbean.com/itinerary/3-night-bahamas-getaway-cruise-from-fort-lauderdale-on-jewel-JW3BH224</loc></url>
          <url><loc>https://www.royalcaribbean.com/itinerary/3-night-ensenada-cruise-from-los-angeles-on-ovation-OV03X039</loc></url>
          <url><loc>https://www.royalcaribbean.com/cruise-ships/jewel-of-the-seas</loc></url>
        </urlset>`;
      const entries = parseSitemapXml(xml);
      expect(entries).toHaveLength(2);
      expect(entries[0]?.packageCode).toBe("JW3BH224");
      expect(entries[1]?.packageCode).toBe("OV03X039");
    });

    it("returns an empty array for an empty sitemap", () => {
      expect(parseSitemapXml("<urlset></urlset>")).toEqual([]);
    });
  });
});
