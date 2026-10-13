import { describe, expect, it, vi } from "vitest";

import {
  CaptchaError,
  CdpTransportClosedError,
  EmptyResultsError,
  SelectorFailureError,
  SessionLifetimeExceededError,
  SessionTimeoutError,
  StepVerificationError,
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

    it("aborts on SessionLifetimeExceededError without retry or session restart", async () => {
      const counter = { n: 0 };
      const onSessionRestart = vi.fn(async () => {});
      await expect(
        withScraperRetry(
          async () => {
            counter.n += 1;
            throw new SessionLifetimeExceededError("session lifetime reached");
          },
          { maxAttempts: 3, onSessionRestart }
        )
      ).rejects.toThrow(/session lifetime reached/);
      expect(counter.n).toBe(1);
      expect(onSessionRestart).not.toHaveBeenCalled();
    });

    it("aborts on a name-matched SessionLifetimeExceededError from another realm", async () => {
      const counter = { n: 0 };
      await expect(
        withScraperRetry(
          async () => {
            counter.n += 1;
            const foreign = new Error("foreign lifetime");
            foreign.name = "SessionLifetimeExceededError";
            throw foreign;
          },
          { maxAttempts: 3 }
        )
      ).rejects.toThrow(/foreign lifetime/);
      expect(counter.n).toBe(1);
    });

    it("aborts on a lifetime death whose message looks like a timeout, without restart", async () => {
      const counter = { n: 0 };
      const onSessionRestart = vi.fn(async () => {});
      await expect(
        withScraperRetry(
          async () => {
            counter.n += 1;
            throw new SessionLifetimeExceededError("session timed out: lifetime reached");
          },
          { maxAttempts: 3, onSessionRestart }
        )
      ).rejects.toThrow(/lifetime reached/);
      expect(counter.n).toBe(1);
      expect(onSessionRestart).not.toHaveBeenCalled();
    });

    it("aborts on a foreign-realm lifetime error even when the classifier would map it to a timeout", async () => {
      const counter = { n: 0 };
      const onSessionRestart = vi.fn(async () => {});
      await expect(
        withScraperRetry(
          async () => {
            counter.n += 1;
            const foreign = new Error("Timeout: session lifetime exceeded");
            foreign.name = "SessionLifetimeExceededError";
            throw foreign;
          },
          { maxAttempts: 3, onSessionRestart }
        )
      ).rejects.toThrow(/lifetime exceeded/);
      expect(counter.n).toBe(1);
      expect(onSessionRestart).not.toHaveBeenCalled();
    });

    const timeoutShapedLifetimeDeaths: Array<{ name: string; make: () => Error }> = [
      {
        name: "SessionTimeoutError-shaped message",
        make: () => new Error("Timeout 30000ms exceeded: session lifetime reached"),
      },
      {
        name: "CdpTransportClosedError-shaped message",
        make: () => new CdpTransportClosedError("cdp transport closed: session lifetime reached"),
      },
      {
        name: "SessionTimeoutError instance",
        make: () => new SessionTimeoutError("session timed out: lifetime reached"),
      },
    ];

    for (const c of timeoutShapedLifetimeDeaths) {
      it(`rejects after exactly one invocation for a lifetime death (${c.name})`, async () => {
        const counter = { n: 0 };
        const onSessionRestart = vi.fn(async () => {});
        await expect(
          withScraperRetry(
            async () => {
              counter.n += 1;
              const raw = c.make();
              throw raw instanceof SessionTimeoutError || raw instanceof CdpTransportClosedError
                ? new SessionLifetimeExceededError(raw.message)
                : Object.assign(raw, { name: "SessionLifetimeExceededError" });
            },
            { maxAttempts: 3, onSessionRestart }
          )
        ).rejects.toThrow(/lifetime/);
        expect(counter.n).toBe(1);
        expect(onSessionRestart).not.toHaveBeenCalled();
      });
    }

    it("emits logger.error on CaptchaError so ops can alert on it", async () => {
      loggerStub.error.mockClear();
      await expect(
        withScraperRetry(async () => {
          throw new CaptchaError("hCaptcha challenge encountered");
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

    it("aborts immediately on StepVerificationError without retrying", async () => {
      const counter = { n: 0 };
      await expect(
        withScraperRetry(
          async () => {
            counter.n += 1;
            throw new StepVerificationError();
          },
          { maxAttempts: 3 }
        )
      ).rejects.toThrow(/verification/);
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

    it("invokes onSessionRestart for every SessionTimeoutError attempt", async () => {
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
      expect(restarted.n).toBe(3);
      expect(counter.n).toBe(3);
    });

    it("invokes onSessionRestart for every CdpTransportClosedError attempt", async () => {
      const restarted = { n: 0 };
      const counter = { n: 0 };
      await expect(
        withScraperRetry(
          async () => {
            counter.n += 1;
            throw new CdpTransportClosedError();
          },
          {
            maxAttempts: 3,
            onSessionRestart: async () => {
              restarted.n += 1;
            },
          }
        )
      ).rejects.toThrow();
      expect(restarted.n).toBe(3);
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

    it("onSessionRestart fires once per timeout across multiple attempts", async () => {
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
      expect(restarted.n).toBe(3);
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
    // Table-driven pin of what real target-site failure shapes map to. Each
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
        name: "Steel 503 from the target site (retriable as unknown)",
        raw: new Error("target site responded 503 Service Unavailable"),
        expected: UnknownScraperError,
      },
      {
        name: "fetch network abort (DOMException-style name)",
        // Simulate the node 20 abort shape — name is AbortError, message is "aborted".
        raw: Object.assign(new Error("The operation was aborted"), { name: "AbortError" }),
        expected: UnknownScraperError,
      },
      {
        name: "target site 200 body with errors[] (propagated as JSON string)",
        raw: 'graphql response contained errors: [{"message":"internal"}]',
        expected: UnknownScraperError,
      },
      {
        name: "Stagehand selector failure",
        raw: new Error("Could not find element matching selector [data-testid=price]"),
        expected: SelectorFailureError,
      },
      {
        name: "Stagehand CDP operation timeout",
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
        raw: new Error("received no results from the target"),
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
