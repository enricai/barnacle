import { describe, expect, it } from "vitest";

import { randomViewport } from "@/scraper/throttle";

describe("scraper/throttle", () => {
  describe("randomViewport", () => {
    it("returns a desktop-sized viewport within plausible bounds", () => {
      for (let i = 0; i < 50; i += 1) {
        const { width, height } = randomViewport();
        expect(width).toBeGreaterThanOrEqual(1280);
        expect(width).toBeLessThanOrEqual(1920);
        expect(height).toBeGreaterThanOrEqual(720);
        expect(height).toBeLessThanOrEqual(1080);
      }
    });
  });
});
