import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { fetchSitemapItineraries, parseItineraryUrl, parseSitemapXml } from "@/scraper/sitemap";

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

  describe("fetchSitemapItineraries", () => {
    beforeEach(() => {
      vi.stubGlobal("fetch", vi.fn());
    });
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("fetches the sitemap URL and parses the XML body into entries", async () => {
      const xml = `<urlset>
        <url><loc>https://www.royalcaribbean.com/itinerary/3-night-bahamas-getaway-cruise-from-fort-lauderdale-on-jewel-JW3BH224</loc></url>
      </urlset>`;
      vi.mocked(globalThis.fetch).mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: "OK",
        text: async () => xml,
      } as unknown as Response);

      const entries = await fetchSitemapItineraries("https://test.example/sitemap.xml");
      expect(entries).toHaveLength(1);
      expect(entries[0]?.packageCode).toBe("JW3BH224");
      const [url, init] = vi.mocked(globalThis.fetch).mock.calls[0] ?? [];
      expect(url).toBe("https://test.example/sitemap.xml");
      // We send a browser-ish UA so RC doesn't 403 a bare node-fetch
      // signature.
      const headers = (init as { headers?: Record<string, string> } | undefined)?.headers;
      expect(headers?.["user-agent"]).toContain("Mozilla");
    });

    it("throws when the upstream returns a non-2xx", async () => {
      vi.mocked(globalThis.fetch).mockResolvedValueOnce({
        ok: false,
        status: 503,
        statusText: "Service Unavailable",
        text: async () => "",
      } as unknown as Response);

      await expect(fetchSitemapItineraries("https://test.example/sitemap.xml")).rejects.toThrow(
        /503 Service Unavailable/
      );
    });

    it("passes an AbortSignal so stalled upstreams can't hang the worker tick", async () => {
      vi.mocked(globalThis.fetch).mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => "<urlset></urlset>",
      } as unknown as Response);
      await fetchSitemapItineraries("https://test.example/sitemap.xml");
      const init = vi.mocked(globalThis.fetch).mock.calls[0]?.[1] as
        | { signal?: AbortSignal }
        | undefined;
      expect(init?.signal).toBeInstanceOf(AbortSignal);
    });

    it("maps a TimeoutError into a descriptive Error with the timeout budget", async () => {
      const timeoutErr = Object.assign(new Error("The operation timed out"), {
        name: "TimeoutError",
      });
      vi.mocked(globalThis.fetch).mockRejectedValueOnce(timeoutErr);
      await expect(fetchSitemapItineraries("https://test.example/sitemap.xml")).rejects.toThrow(
        /timed out/
      );
    });
  });
});
