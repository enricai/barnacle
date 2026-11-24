import type { Page, Stagehand } from "@browserbasehq/stagehand";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { MetricsCollector } from "@/lib/dispatch-metrics";

import { buildNavigateSettle, createCaptureTracker, navigateActivePage } from "@/scraper/navigate";

const TEST_URL = "https://example.com/apply/123";

function makeStagehand(page: Page): Stagehand {
  return {
    context: {
      awaitActivePage: vi.fn().mockResolvedValue(page),
    },
  } as unknown as Stagehand;
}

function makePage(): Page {
  return {
    goto: vi.fn().mockResolvedValue(undefined),
  } as unknown as Page;
}

describe("navigateActivePage", () => {
  let page: Page;
  let stagehand: Stagehand;

  beforeEach(() => {
    page = makePage();
    stagehand = makeStagehand(page);
  });

  it("awaits the active page and calls goto with domcontentloaded", async () => {
    await navigateActivePage(stagehand, TEST_URL);

    expect(stagehand.context.awaitActivePage).toHaveBeenCalledOnce();
    expect(page.goto).toHaveBeenCalledOnce();
    expect(page.goto).toHaveBeenCalledWith(TEST_URL, { waitUntil: "domcontentloaded" });
  });

  it("returns the active page", async () => {
    const result = await navigateActivePage(stagehand, TEST_URL);
    expect(result).toBe(page);
  });

  it("records a successful navigate step when a collector is provided", async () => {
    const collector = new MetricsCollector();
    const startSpy = vi.spyOn(collector, "startStep");
    const endSpy = vi.spyOn(collector, "endStep");

    await navigateActivePage(stagehand, TEST_URL, collector);

    expect(startSpy).toHaveBeenCalledOnce();
    expect(startSpy).toHaveBeenCalledWith("navigate");
    expect(endSpy).toHaveBeenCalledOnce();
    expect(endSpy).toHaveBeenCalledWith("success");
  });

  it("records no collector steps when no collector is provided", async () => {
    await expect(navigateActivePage(stagehand, TEST_URL)).resolves.toBe(page);
    expect(page.goto).toHaveBeenCalledOnce();
  });

  it("forwards timeoutMs to goto when provided", async () => {
    await navigateActivePage(stagehand, TEST_URL, undefined, 60_000);

    expect(page.goto).toHaveBeenCalledWith(TEST_URL, {
      waitUntil: "domcontentloaded",
      timeoutMs: 60_000,
    });
  });
});

describe("navigate settle on declared capture", () => {
  const API = "https://api.acme-jobs.test/v1/apply/submit";
  const BODY = '{"op":"loadForm"}';

  it("returns undefined (no wait) when no endpoint pattern is declared", async () => {
    const tracker = createCaptureTracker();
    expect(buildNavigateSettle(tracker, undefined)).toBeUndefined();
    expect(buildNavigateSettle(tracker, null, "loadForm")).toBeUndefined();
    const page = makePage();
    await expect(navigateActivePage(makeStagehand(page), TEST_URL)).resolves.toBe(page);
    expect(page.goto).toHaveBeenCalledWith(TEST_URL, { waitUntil: "domcontentloaded" });
  });

  it("times out when no matching capture arrives", async () => {
    const tracker = createCaptureTracker();
    const settle = buildNavigateSettle(tracker, "/v1/apply/", "loadForm");
    const w = settle?.();
    tracker.observe("https://api.acme-jobs.test/other", BODY);
    expect(await w?.wait({ timeoutMs: 60, quietMs: 20 })).toBe("timeout");
  });

  it("ignores captures whose body does not match the declared body pattern", async () => {
    const tracker = createCaptureTracker();
    const w = buildNavigateSettle(tracker, "/v1/apply/", "loadForm")?.();
    tracker.observe(API, '{"op":"other"}');
    tracker.observe(API, null);
    expect(await w?.wait({ timeoutMs: 60, quietMs: 20 })).toBe("timeout");
  });

  it("settles only after the quiet window following a matching endpoint+body capture", async () => {
    const tracker = createCaptureTracker();
    const w = buildNavigateSettle(tracker, "/v1/apply/", "loadForm")?.();
    const start = Date.now();
    setTimeout(() => tracker.observe(API, BODY), 30);
    expect(await w?.wait({ timeoutMs: 2000, quietMs: 100 })).toBe("settled");
    expect(Date.now() - start).toBeGreaterThanOrEqual(120);
  });

  it("extends the quiet window when another matching capture arrives", async () => {
    const tracker = createCaptureTracker();
    const w = buildNavigateSettle(tracker, "/v1/apply/")?.();
    const start = Date.now();
    tracker.observe(API, "");
    setTimeout(() => tracker.observe(API, ""), 80);
    expect(await w?.wait({ timeoutMs: 2000, quietMs: 100 })).toBe("settled");
    expect(Date.now() - start).toBeGreaterThanOrEqual(170);
  });

  it("does not count captures observed before the settle window began", async () => {
    const tracker = createCaptureTracker();
    tracker.observe(API, BODY);
    const w = buildNavigateSettle(tracker, "/v1/apply/", "loadForm")?.();
    expect(await w?.wait({ timeoutMs: 60, quietMs: 20 })).toBe("timeout");
  });
});
