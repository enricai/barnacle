import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockPage = vi.hoisted(() => ({
  goto: vi.fn().mockResolvedValue(undefined),
  waitForTimeout: vi.fn().mockResolvedValue(undefined),
}));

const mockStagehand = vi.hoisted(() => ({
  context: {
    awaitActivePage: vi.fn().mockResolvedValue(mockPage),
  },
}));

const mockClose = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockCreateSession = vi.hoisted(() =>
  vi.fn().mockResolvedValue({
    stagehand: mockStagehand,
    sessionId: "bb-test-session",
    close: mockClose,
  })
);

vi.mock("@/scraper/session-browserbase", () => ({
  createBrowserbaseBrowserSession: mockCreateSession,
}));

vi.mock("@/lib/dd-metrics", () => ({
  recordTrackingClickAttempt: vi.fn(),
  recordTrackingClickSuccess: vi.fn(),
  recordTrackingClickFailure: vi.fn(),
  recordTrackingClickDuration: vi.fn(),
}));

import {
  recordTrackingClickAttempt,
  recordTrackingClickFailure,
  recordTrackingClickSuccess,
} from "@/lib/dd-metrics";
import { drainTrackingClicks, fireTrackingClick } from "@/lib/tracking-click";

describe("fireTrackingClick", () => {
  beforeEach(() => {
    mockCreateSession.mockResolvedValue({
      stagehand: mockStagehand,
      sessionId: "bb-test-session",
      close: mockClose,
    });
    mockPage.goto.mockResolvedValue(undefined);
    mockPage.waitForTimeout.mockResolvedValue(undefined);
    mockClose.mockResolvedValue(undefined);
    mockStagehand.context.awaitActivePage.mockResolvedValue(mockPage);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("creates a Browserbase session with advancedStealth and navigates to the tracking URL", async () => {
    fireTrackingClick("https://click.appcast.io/t/abc?vivclid=123", "appcast");
    await drainTrackingClicks();

    expect(mockCreateSession).toHaveBeenCalledWith({ advancedStealth: true });
    expect(mockPage.goto).toHaveBeenCalledWith("https://click.appcast.io/t/abc?vivclid=123", {
      waitUntil: "domcontentloaded",
      timeoutMs: 30_000,
    });
    expect(mockPage.waitForTimeout).toHaveBeenCalledWith(5_000);
    expect(mockClose).toHaveBeenCalledOnce();
  });

  it("records attempt and success metrics on success", async () => {
    fireTrackingClick("https://click.appcast.io/t/abc", "appcast");
    await drainTrackingClicks();

    expect(recordTrackingClickAttempt).toHaveBeenCalledWith("appcast");
    expect(recordTrackingClickSuccess).toHaveBeenCalledWith("appcast");
    expect(recordTrackingClickFailure).not.toHaveBeenCalled();
  });

  it("closes the session even when navigation throws", async () => {
    mockPage.goto.mockRejectedValueOnce(new Error("navigation timeout"));
    fireTrackingClick("https://click.appcast.io/t/abc", "appcast");
    await drainTrackingClicks();

    expect(mockClose).toHaveBeenCalledOnce();
    expect(recordTrackingClickFailure).toHaveBeenCalledWith("appcast", "Error");
  });

  it("closes the session even when session creation throws", async () => {
    mockCreateSession.mockRejectedValueOnce(new Error("no API key"));
    fireTrackingClick("https://click.appcast.io/t/abc", "appcast");
    await drainTrackingClicks();

    expect(recordTrackingClickFailure).toHaveBeenCalledWith("appcast", "Error");
  });

  it("does not throw — errors are swallowed", async () => {
    mockCreateSession.mockRejectedValueOnce(new Error("boom"));
    fireTrackingClick("https://click.appcast.io/t/abc", "appcast");
    await expect(drainTrackingClicks()).resolves.toBeUndefined();
  });

  it("drainTrackingClicks resolves immediately when no clicks are in-flight", async () => {
    await expect(drainTrackingClicks()).resolves.toBeUndefined();
  });

  it("drainTrackingClicks waits for in-flight clicks to complete", async () => {
    let resolveGoto!: () => void;
    mockPage.goto.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        resolveGoto = resolve;
      })
    );

    fireTrackingClick("https://click.appcast.io/t/slow", "appcast");

    const drainPromise = drainTrackingClicks(5_000);
    resolveGoto();
    await drainPromise;

    expect(mockClose).toHaveBeenCalledOnce();
  });
});
