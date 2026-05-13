import { describe, expect, it, vi } from "vitest";

import {
  CaptchaError,
  EmptyResultsError,
  SelectorFailureError,
  SessionTimeoutError,
  UnknownScraperError,
} from "@/scraper/errors";
import { classifyScraperError, withScraperRetry } from "@/scraper/retry";

// Hoist-safe mock so retry.ts's own module-level getLogger call receives
// our stub — required because vitest mocks need to be registered before
// the module under test imports logging.ts.
const { loggerStub } = vi.hoisted(() => ({
  loggerStub: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    errorWithStack: vi.fn(),
  },
}));
vi.mock("@/lib/logging", () => ({ getLogger: () => loggerStub }));

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

    it("emits logger.error on CaptchaError so ops can alert on it (task 10)", async () => {
      loggerStub.error.mockClear();
      await expect(
        withScraperRetry(async () => {
          throw new CaptchaError("hCaptcha challenge from RC");
        })
      ).rejects.toThrow(/captcha/i);
      expect(loggerStub.error).toHaveBeenCalledOnce();
      const msg = loggerStub.error.mock.calls[0]?.[0];
      expect(msg).toMatch(/captcha/i);
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

    it("calls onRetry with the classified error and attempt number", async () => {
      const calls: Array<{ name: string; attempt: number }> = [];
      await expect(
        withScraperRetry(
          async () => {
            throw new SelectorFailureError("nope");
          },
          {
            maxAttempts: 2,
            onRetry: async (err, attempt) => {
              calls.push({ name: err.name, attempt });
            },
          }
        )
      ).rejects.toThrow();
      // onFailedAttempt fires on each failed attempt.
      expect(calls.length).toBe(2);
      expect(calls.every((c) => c.name === "SelectorFailureError")).toBe(true);
      expect(calls.map((c) => c.attempt)).toEqual([1, 2]);
    });

    it("onSessionRestart fires at most once even across multiple timeouts", async () => {
      const restarted = { n: 0 };
      await expect(
        withScraperRetry(
          async () => {
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
    });

    it("wraps non-ScraperError throws as UnknownScraperError before retrying", async () => {
      const counter = { n: 0 };
      await expect(
        withScraperRetry(
          async () => {
            counter.n += 1;
            throw new Error("generic boom");
          },
          { maxAttempts: 2 }
        )
      ).rejects.toThrow(/generic boom/);
      expect(counter.n).toBe(2);
    });
  });

  describe("classifyScraperError additional branches", () => {
    it("maps 'empty' mentions to EmptyResultsError", () => {
      expect(classifyScraperError(new Error("empty results returned"))).toBeInstanceOf(
        EmptyResultsError
      );
    });

    it("maps 'no results' to EmptyResultsError", () => {
      expect(classifyScraperError(new Error("no results match"))).toBeInstanceOf(EmptyResultsError);
    });

    it("maps 'not found' to SelectorFailureError", () => {
      expect(classifyScraperError(new Error("button not found"))).toBeInstanceOf(
        SelectorFailureError
      );
    });
  });

  describe("classifyScraperError real-world error messages", () => {
    // Table-driven pin of what real upstream failure shapes map to. Each
    // row is a failure we've either seen or expect to see in prod, so a
    // future edit to classifyScraperError can't silently reclassify
    // something retriable as an abort (or vice versa).
    const cases: Array<{
      name: string;
      raw: unknown;
      expected:
        | typeof CaptchaError
        | typeof SessionTimeoutError
        | typeof SelectorFailureError
        | typeof EmptyResultsError
        | typeof UnknownScraperError;
    }> = [
      {
        name: "Steel 503 upstream (retriable as unknown)",
        raw: new Error("upstream responded 503 Service Unavailable"),
        expected: UnknownScraperError,
      },
      {
        name: "fetch network abort (DOMException-style name)",
        // Simulate the node 20 abort shape — name is AbortError, message is "aborted".
        raw: Object.assign(new Error("The operation was aborted"), { name: "AbortError" }),
        expected: UnknownScraperError,
      },
      {
        name: "GraphQL 200 body with errors[] (propagated as JSON string)",
        raw: 'graphql response contained errors: [{"message":"internal"}]',
        expected: UnknownScraperError,
      },
      {
        name: "Stagehand selector failure",
        raw: new Error("Could not find element matching selector [data-testid=price]"),
        expected: SelectorFailureError,
      },
      {
        name: "Playwright page.waitForSelector timeout",
        raw: new Error("Timeout 30000ms exceeded while waiting for selector"),
        expected: SessionTimeoutError,
      },
      {
        name: "hCaptcha challenge surfaced by Steel",
        raw: new Error("Blocked by captcha challenge"),
        expected: CaptchaError,
      },
      {
        name: "extractor returns no results",
        raw: new Error("received 0 sailing cards — no results"),
        expected: EmptyResultsError,
      },
    ];

    for (const c of cases) {
      it(`${c.name} → ${c.expected.name}`, () => {
        expect(classifyScraperError(c.raw)).toBeInstanceOf(c.expected);
      });
    }
  });
});
