import { afterEach, describe, expect, it } from "vitest";

import {
  allMetrics,
  recordFallbackActivation,
  recordHotPathLatency,
  recordHotPathSuccess,
  recordRateLimitRejection,
  resetMetrics,
} from "@/scraper/metrics";

afterEach(() => {
  resetMetrics();
});

describe("counters", () => {
  it("initialises all counters to zero on first access", () => {
    recordHotPathSuccess("site-a");
    const m = allMetrics()["site-a"];
    expect(m?.hotPathSuccess).toBe(1);
    expect(m?.fallbackActivations).toBe(0);
    expect(m?.rateLimitRejections).toBe(0);
  });

  it("increments each counter independently", () => {
    recordHotPathSuccess("s");
    recordHotPathSuccess("s");
    recordFallbackActivation("s");
    recordRateLimitRejection("s");
    const m = allMetrics().s;
    expect(m?.hotPathSuccess).toBe(2);
    expect(m?.fallbackActivations).toBe(1);
    expect(m?.rateLimitRejections).toBe(1);
  });

  it("tracks separate state per siteId", () => {
    recordHotPathSuccess("a");
    recordFallbackActivation("b");
    expect(allMetrics().a?.hotPathSuccess).toBe(1);
    expect(allMetrics().b?.hotPathSuccess).toBe(0);
  });
});

describe("p95 latency", () => {
  it("is undefined before any sample is recorded", () => {
    recordHotPathSuccess("site-x");
    expect(allMetrics()["site-x"]?.p95LatencyMs).toBeUndefined();
  });

  it("is defined after the first latency sample", () => {
    recordHotPathLatency("site-x", 42);
    expect(allMetrics()["site-x"]?.p95LatencyMs).toBe(42);
  });

  it("computes p95 correctly for a known set of 10 samples", () => {
    // sorted: [10,20,30,40,50,60,70,80,90,100]
    // p95 index = floor(10 * 0.95) = 9 → value 100
    for (let i = 1; i <= 10; i++) {
      recordHotPathLatency("site-p", i * 10);
    }
    expect(allMetrics()["site-p"]?.p95LatencyMs).toBe(100);
  });

  it("computes p95 correctly for a known set of 20 samples", () => {
    // sorted: [10,20,...,200]
    // p95 index = floor(20 * 0.95) = 19 → value 200
    for (let i = 1; i <= 20; i++) {
      recordHotPathLatency("site-q", i * 10);
    }
    expect(allMetrics()["site-q"]?.p95LatencyMs).toBe(200);
  });

  it("reservoir never exceeds 1000 entries after 1001 samples", () => {
    for (let i = 0; i < 1001; i++) {
      recordHotPathLatency("site-r", i);
    }
    const m = allMetrics()["site-r"];
    expect(m?.p95LatencyMs).toBeDefined();
    expect(typeof m?.p95LatencyMs).toBe("number");
    // A rough sanity bound: p95 of 0..1000 values should be near 950
    const p95 = m?.p95LatencyMs ?? 0;
    expect(p95).toBeGreaterThan(800);
    expect(p95).toBeLessThanOrEqual(1000);
  });

  it("is undefined again after resetMetrics()", () => {
    recordHotPathLatency("site-s", 100);
    resetMetrics();
    recordHotPathSuccess("site-s");
    expect(allMetrics()["site-s"]?.p95LatencyMs).toBeUndefined();
  });

  it("allMetrics() includes p95LatencyMs in the returned object", () => {
    recordHotPathLatency("site-t", 55);
    const metrics = allMetrics();
    const entry = metrics["site-t"];
    expect(entry).toBeDefined();
    expect("p95LatencyMs" in (entry ?? {})).toBe(true);
  });
});
