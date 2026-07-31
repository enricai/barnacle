import { describe, expect, it } from "vitest";

import { chromiumClientHints } from "@/lib/chromium-client-hints";

describe("lib/chromium-client-hints chromiumClientHints", () => {
  it("reproduces clearcompany BASE_HEADERS client-hint quartet exactly", () => {
    const result = chromiumClientHints({
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      secChUa: '"Chromium";v="148", "Google Chrome";v="148", "Not/A)Brand";v="99"',
      platform: "Linux",
    });

    expect(result).toEqual({
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      "sec-ch-ua": '"Chromium";v="148", "Google Chrome";v="148", "Not/A)Brand";v="99"',
      "sec-ch-ua-mobile": "?0",
      "sec-ch-ua-platform": '"Linux"',
    });
  });

  it("reproduces encompasshealth BASE_HEADERS client-hint quartet exactly", () => {
    const result = chromiumClientHints({
      userAgent:
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
      secChUa: '"Google Chrome";v="149", "Chromium";v="149", "Not)A;Brand";v="24"',
      platform: "Linux",
    });

    expect(result).toEqual({
      "User-Agent":
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
      "sec-ch-ua": '"Google Chrome";v="149", "Chromium";v="149", "Not)A;Brand";v="24"',
      "sec-ch-ua-mobile": "?0",
      "sec-ch-ua-platform": '"Linux"',
    });
  });
});
