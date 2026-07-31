import { afterEach, describe, expect, it } from "vitest";

import { ERROR_SINK_PATH_SEGMENT, isNoiseUrl, telemetryUrlPatterns } from "@/recon/capture-filters";

const originalTelemetryEnv = process.env.RECON_TELEMETRY_URL_PATTERNS;

afterEach(() => {
  if (originalTelemetryEnv === undefined) delete process.env.RECON_TELEMETRY_URL_PATTERNS;
  else process.env.RECON_TELEMETRY_URL_PATTERNS = originalTelemetryEnv;
});

describe("isNoiseUrl — third-party asset/telemetry hosts", () => {
  it("skips the ad-tech and session-replay hosts recon wastes time on", () => {
    expect(isNoiseUrl("https://x.clicktale.net/collect")).toBe(true);
    expect(isNoiseUrl("https://sync.adsrvr.org/track")).toBe(true);
    expect(isNoiseUrl("https://analytics.tiktok.com/api/v2/pixel")).toBe(true);
    expect(isNoiseUrl("https://connect.facebook.net/en_US/fbevents.js")).toBe(true);
  });

  it("keeps the site's own API endpoint", () => {
    expect(isNoiseUrl("https://apply.acme.example/dcl-apps/available-products/")).toBe(false);
  });

  it("skips a same-host error-reporting sink but keeps data endpoints that spell 'error'", () => {
    expect(isNoiseUrl("https://apply.acme.example/dcl-apps-spa/error")).toBe(true);
    expect(isNoiseUrl("https://apply.acme.example/api/error-codes")).toBe(false);
    expect(isNoiseUrl("https://apply.acme.example/api/terrorism-screening")).toBe(false);
  });

  it("skips static assets served under the site host", () => {
    expect(isNoiseUrl("https://apply.acme.example/static/main.js")).toBe(true);
    expect(isNoiseUrl("https://apply.acme.example/assets/logo.png")).toBe(true);
  });

  it("does not throw on an unparseable url", () => {
    expect(isNoiseUrl("not a url")).toBe(false);
  });
});

describe("telemetryUrlPatterns — env seam read at call time", () => {
  it("includes RECON_TELEMETRY_URL_PATTERNS additions set after import", () => {
    process.env.RECON_TELEMETRY_URL_PATTERNS = "parksmedia,my-tracker.example";
    const patterns = telemetryUrlPatterns();
    expect(patterns).toContain("parksmedia");
    expect(patterns).toContain("my-tracker.example");
    expect(isNoiseUrl("https://apply.acme.example/parksmedia/asset")).toBe(true);
  });
});

describe("ERROR_SINK_PATH_SEGMENT", () => {
  it("matches a whole error/errors segment only", () => {
    expect(ERROR_SINK_PATH_SEGMENT.test("/error")).toBe(true);
    expect(ERROR_SINK_PATH_SEGMENT.test("/api/errors/report")).toBe(true);
    expect(ERROR_SINK_PATH_SEGMENT.test("/error-codes")).toBe(false);
  });
});
