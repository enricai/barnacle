import { describe, expect, it, vi } from "vitest";
import { z } from "zod/v4";

import { createRateLimitedJsonClient } from "@/scraper/rate-limited-json-client";

describe("scraper/rate-limited-json-client createRateLimitedJsonClient", () => {
  it("returns a callable function", () => {
    const client = createRateLimitedJsonClient({
      minTimeMs: 0,
      userAgent: "TestAgent/1.0 Chrome/99",
      secChUa: '"Chromium";v="99"',
      platform: "Linux",
      schema: z.unknown(),
    });
    expect(typeof client).toBe("function");
  });

  it("merges Chromium client-hint quartet and extraHeaders into outbound request headers", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      status: 200,
      headers: new Headers(),
      text: () => Promise.resolve(JSON.stringify({})),
    } as unknown as Response);

    const client = createRateLimitedJsonClient({
      minTimeMs: 0,
      userAgent: "Mozilla/5.0 Chrome/99",
      secChUa: '"Chromium";v="99", "Google Chrome";v="99"',
      platform: "Linux",
      extraHeaders: {
        "Content-Type": "application/json",
        "X-Site-Header": "test-value",
      },
      schema: z.unknown(),
    });

    await client("https://example.com/api");

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [, init] = fetchSpy.mock.calls[0] ?? [];
    const headers = init?.headers as Record<string, string>;

    expect(headers["User-Agent"]).toBe("Mozilla/5.0 Chrome/99");
    expect(headers["sec-ch-ua"]).toBe('"Chromium";v="99", "Google Chrome";v="99"');
    expect(headers["sec-ch-ua-mobile"]).toBe("?0");
    expect(headers["sec-ch-ua-platform"]).toBe('"Linux"');
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers["X-Site-Header"]).toBe("test-value");

    fetchSpy.mockRestore();
  });

  it("extraHeaders override chromiumClientHints when keys collide", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      status: 200,
      headers: new Headers(),
      text: () => Promise.resolve(JSON.stringify(null)),
    } as unknown as Response);

    const client = createRateLimitedJsonClient({
      minTimeMs: 0,
      userAgent: "original-agent",
      secChUa: '"Chromium";v="1"',
      platform: "Linux",
      extraHeaders: {
        "User-Agent": "overridden-agent",
      },
      schema: z.unknown(),
    });

    await client("https://example.com/api");

    const [, init] = fetchSpy.mock.calls[0] ?? [];
    const headers = init?.headers as Record<string, string>;
    expect(headers["User-Agent"]).toBe("overridden-agent");

    fetchSpy.mockRestore();
  });
});
