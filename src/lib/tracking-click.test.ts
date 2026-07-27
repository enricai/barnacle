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

const mockCaptureBeaconEvent = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("@/lib/telemetry/beacon-capture", () => ({
  captureBeaconEvent: mockCaptureBeaconEvent,
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
    fireTrackingClick("https://click.acme.example/t/abc?vivclid=123", "ats-c");
    await drainTrackingClicks();

    expect(mockCreateSession).toHaveBeenCalledWith({
      advancedStealth: true,
      browserbaseSessionCreateParams: { timeout: 300 },
    });
    expect(mockPage.goto).toHaveBeenCalledWith("https://click.acme.example/t/abc?vivclid=123", {
      waitUntil: "domcontentloaded",
      timeoutMs: 30_000,
    });
    expect(mockPage.waitForTimeout).toHaveBeenCalledWith(5_000);
    expect(mockClose).toHaveBeenCalledOnce();
  });

  it("records attempt and success metrics on success", async () => {
    fireTrackingClick("https://click.acme.example/t/abc", "ats-c");
    await drainTrackingClicks();

    expect(recordTrackingClickAttempt).toHaveBeenCalledWith("ats-c");
    expect(recordTrackingClickSuccess).toHaveBeenCalledWith("ats-c");
    expect(recordTrackingClickFailure).not.toHaveBeenCalled();
  });

  it("closes the session even when navigation throws", async () => {
    mockPage.goto.mockRejectedValueOnce(new Error("navigation timeout"));
    fireTrackingClick("https://click.acme.example/t/abc", "ats-c");
    await drainTrackingClicks();

    expect(mockClose).toHaveBeenCalledOnce();
    expect(recordTrackingClickFailure).toHaveBeenCalledWith("ats-c", "Error");
  });

  it("closes the session even when session creation throws", async () => {
    mockCreateSession.mockRejectedValueOnce(new Error("no API key"));
    fireTrackingClick("https://click.acme.example/t/abc", "ats-c");
    await drainTrackingClicks();

    expect(recordTrackingClickFailure).toHaveBeenCalledWith("ats-c", "Error");
  });

  it("does not throw — errors are swallowed", async () => {
    mockCreateSession.mockRejectedValueOnce(new Error("boom"));
    fireTrackingClick("https://click.acme.example/t/abc", "ats-c");
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

    fireTrackingClick("https://click.acme.example/t/slow", "ats-c");

    const drainPromise = drainTrackingClicks(5_000);
    resolveGoto();
    await drainPromise;

    expect(mockClose).toHaveBeenCalledOnce();
  });

  it("does not capture a beacon outcome when the reconciliation context is omitted", async () => {
    fireTrackingClick("https://click.acme.example/t/abc", "ats-c");
    await drainTrackingClicks();

    expect(mockCaptureBeaconEvent).not.toHaveBeenCalled();
  });

  it("captures a fired beacon outcome correlated to the run after a successful navigation", async () => {
    fireTrackingClick("https://click.acme.example/t/abc?vivclid=123", "ats-c", {
      requestId: "req-1",
      joinKeys: { vivclid: "123", jobReference: "emp1_job1" },
    });
    await drainTrackingClicks();

    expect(mockCaptureBeaconEvent).toHaveBeenCalledTimes(1);
    expect(mockCaptureBeaconEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: "req-1",
        siteId: "ats-c",
        joinKeys: { vivclid: "123", jobReference: "emp1_job1" },
        beaconStatus: "fired",
        trackingUrl: "https://click.acme.example/t/abc?vivclid=123",
      })
    );
  });

  it("captures a failed beacon outcome when page.goto rejects", async () => {
    mockPage.goto.mockRejectedValueOnce(new Error("navigation timeout"));
    fireTrackingClick("https://click.acme.example/t/abc", "ats-c", {
      requestId: "req-2",
      joinKeys: null,
    });
    await drainTrackingClicks();

    expect(mockCaptureBeaconEvent).toHaveBeenCalledTimes(1);
    expect(mockCaptureBeaconEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: "req-2",
        siteId: "ats-c",
        beaconStatus: "failed",
      })
    );
  });

  it("captures a failed beacon outcome when session creation rejects", async () => {
    mockCreateSession.mockRejectedValueOnce(new Error("no API key"));
    fireTrackingClick("https://click.acme.example/t/abc", "ats-c", {
      requestId: "req-3",
      joinKeys: { vivclid: "999" },
    });
    await drainTrackingClicks();

    expect(mockCaptureBeaconEvent).toHaveBeenCalledTimes(1);
    expect(mockCaptureBeaconEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: "req-3",
        siteId: "ats-c",
        joinKeys: { vivclid: "999" },
        beaconStatus: "failed",
      })
    );
  });

  it("does not throw when the capture sink itself rejects", async () => {
    mockCaptureBeaconEvent.mockRejectedValueOnce(new Error("sink write failed"));
    fireTrackingClick("https://click.acme.example/t/abc", "ats-c", {
      requestId: "req-4",
      joinKeys: null,
    });

    await expect(drainTrackingClicks()).resolves.toBeUndefined();
  });

  it("drainTrackingClicks resolves after the beacon outcome is captured", async () => {
    let resolveCapture!: () => void;
    mockCaptureBeaconEvent.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        resolveCapture = resolve;
      })
    );

    fireTrackingClick("https://click.acme.example/t/abc", "ats-c", {
      requestId: "req-5",
      joinKeys: null,
    });

    const drainPromise = drainTrackingClicks(5_000);
    let drained = false;
    drainPromise.then(() => {
      drained = true;
    });

    await Promise.resolve();
    expect(drained).toBe(false);

    resolveCapture();
    await drainPromise;
    expect(drained).toBe(true);
  });
});
