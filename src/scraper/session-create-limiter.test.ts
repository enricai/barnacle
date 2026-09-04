import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BrowserbaseSessionCreateRateLimitError, CaptchaError } from "@/scraper/errors";
import { scheduleSessionCreate } from "@/scraper/session-create-limiter";

describe("scraper/session-create-limiter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("scheduleSessionCreate", () => {
    it("paces concurrent calls to at least the configured minimum interval", async () => {
      const timestamps: number[] = [];
      const fn = async (): Promise<void> => {
        timestamps.push(Date.now());
      };

      const calls = Promise.all([scheduleSessionCreate(fn), scheduleSessionCreate(fn)]);
      await vi.runAllTimersAsync();
      await calls;

      expect(timestamps).toHaveLength(2);
      const [first, second] = timestamps as [number, number];
      expect(second - first).toBeGreaterThanOrEqual(250);
    });

    it("retries a session-create 429 with backoff and resolves once it succeeds", async () => {
      let attempts = 0;
      const fn = async (): Promise<string> => {
        attempts += 1;
        if (attempts < 3) throw new Error("Unknown error: 429");
        return "session-created";
      };

      const call = scheduleSessionCreate(fn);
      await vi.runAllTimersAsync();
      const result = await call;

      expect(result).toBe("session-created");
      expect(attempts).toBe(3);
    });

    it("rethrows BrowserbaseSessionCreateRateLimitError once the retry budget is exhausted", async () => {
      const fn = async (): Promise<never> => {
        throw new Error("Unknown error: 429");
      };

      const call = scheduleSessionCreate(fn);
      const assertion = expect(call).rejects.toBeInstanceOf(BrowserbaseSessionCreateRateLimitError);
      await vi.runAllTimersAsync();
      await assertion;
    });

    it("propagates a non-session-create-429 error immediately with no retry", async () => {
      let attempts = 0;
      const fn = async (): Promise<never> => {
        attempts += 1;
        throw new Error("stagehand init failed: some other reason");
      };

      const call = scheduleSessionCreate(fn);
      const assertion = expect(call).rejects.toThrow("stagehand init failed: some other reason");
      await vi.runAllTimersAsync();
      await assertion;
      expect(attempts).toBe(1);
    });

    it("preserves the original error's type/instanceof through the limiter", async () => {
      const fn = async (): Promise<never> => {
        throw new CaptchaError("captcha detected during init");
      };

      const call = scheduleSessionCreate(fn);
      const assertion = expect(call).rejects.toBeInstanceOf(CaptchaError);
      await vi.runAllTimersAsync();
      await assertion;
    });
  });
});
