import { describe, expect, it } from "vitest";

import {
  CaptchaError,
  EmptyResultsError,
  SelectorFailureError,
  SessionTimeoutError,
  UnknownScraperError,
} from "@/scraper/errors";
import { classifyScraperError, withScraperRetry } from "@/scraper/retry";

describe("scraper/retry", () => {
  describe("classifyScraperError", () => {
    it("maps captcha mentions to CaptchaError", () => {
      expect(classifyScraperError(new Error("got a captcha"))).toBeInstanceOf(CaptchaError);
    });

    it("maps timeouts to SessionTimeoutError", () => {
      expect(classifyScraperError(new Error("request timed out"))).toBeInstanceOf(
        SessionTimeoutError
      );
    });

    it("maps selector failures to SelectorFailureError", () => {
      expect(classifyScraperError(new Error("could not find selector"))).toBeInstanceOf(
        SelectorFailureError
      );
    });

    it("passes through existing ScraperError instances", () => {
      const err = new EmptyResultsError();
      expect(classifyScraperError(err)).toBe(err);
    });

    it("falls back to UnknownScraperError", () => {
      expect(classifyScraperError("weird string failure")).toBeInstanceOf(UnknownScraperError);
    });
  });

  describe("withScraperRetry", () => {
    it("aborts immediately on CaptchaError without retrying", async () => {
      const counter = { n: 0 };
      await expect(
        withScraperRetry(
          async () => {
            counter.n += 1;
            throw new CaptchaError();
          },
          { maxAttempts: 3 }
        )
      ).rejects.toThrow(/captcha/);
      expect(counter.n).toBe(1);
    });

    it("aborts immediately on EmptyResultsError without retrying", async () => {
      const counter = { n: 0 };
      await expect(
        withScraperRetry(
          async () => {
            counter.n += 1;
            throw new EmptyResultsError();
          },
          { maxAttempts: 3 }
        )
      ).rejects.toThrow(/no results/);
      expect(counter.n).toBe(1);
    });

    it("retries SelectorFailureError up to maxAttempts", async () => {
      const counter = { n: 0 };
      await expect(
        withScraperRetry(
          async () => {
            counter.n += 1;
            throw new SelectorFailureError();
          },
          { maxAttempts: 3 }
        )
      ).rejects.toThrow();
      expect(counter.n).toBe(3);
    });

    it("invokes onSessionRestart once for SessionTimeoutError", async () => {
      const restarted = { n: 0 };
      const counter = { n: 0 };
      await expect(
        withScraperRetry(
          async () => {
            counter.n += 1;
            throw new SessionTimeoutError();
          },
          {
            maxAttempts: 3,
            onSessionRestart: async () => {
              restarted.n += 1;
            },
          }
        )
      ).rejects.toThrow();
      expect(restarted.n).toBe(1);
      expect(counter.n).toBe(3);
    });

    it("returns the value on a successful first attempt", async () => {
      const result = await withScraperRetry(async () => "ok");
      expect(result).toBe("ok");
    });

    it("returns the value after transient failures recover", async () => {
      const counter = { n: 0 };
      const result = await withScraperRetry(async () => {
        counter.n += 1;
        if (counter.n < 2) throw new SelectorFailureError();
        return "ok";
      });
      expect(result).toBe("ok");
      expect(counter.n).toBe(2);
    });
  });
});
