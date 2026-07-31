import type { Page, Stagehand } from "@browserbasehq/stagehand";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { MetricsCollector } from "@/lib/dispatch-metrics";

import { navigateActivePage } from "@/scraper/navigate";

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

  it("awaits the active page and calls goto with networkidle", async () => {
    await navigateActivePage(stagehand, TEST_URL);

    expect(stagehand.context.awaitActivePage).toHaveBeenCalledOnce();
    expect(page.goto).toHaveBeenCalledOnce();
    expect(page.goto).toHaveBeenCalledWith(TEST_URL, { waitUntil: "networkidle" });
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
      waitUntil: "networkidle",
      timeoutMs: 60_000,
    });
  });
});
