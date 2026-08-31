/**
 * Tests for solveCaptcha's create+poll cycle against a mocked HTTP layer
 * (via the injected `fetchImpl` seam) and its clean unavailable-provider
 * path when no API key is configured.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import { isCaptchaSolverUnavailableError } from "@/scraper/errors";

const { configRef } = vi.hoisted(() => ({
  configRef: {
    value: {
      scraper: {
        twoCaptchaApiKey: "test-2captcha-key" as string | undefined,
      },
    },
  },
}));

vi.mock("@/config", () => ({
  get config() {
    return configRef.value;
  },
}));

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

import { solveCaptcha } from "@/scraper/captcha-solver";

function jsonResponse(body: unknown): {
  status: number;
  headers: Headers;
  text: () => Promise<string>;
} {
  return { status: 200, headers: new Headers(), text: () => Promise.resolve(JSON.stringify(body)) };
}

describe("scraper/captcha-solver", () => {
  beforeEach(() => {
    configRef.value = { scraper: { twoCaptchaApiKey: "test-2captcha-key" } };
    vi.clearAllMocks();
  });

  it("resolves the token via createTask then a pending-then-ready poll", async () => {
    const calls: { url: string; body: string | undefined }[] = [];
    let pollCount = 0;
    const fetchImpl = vi.fn(async (url: string, init: { body?: Buffer | string }) => {
      calls.push({ url, body: typeof init.body === "string" ? init.body : undefined });
      if (url.endsWith("/in.php")) {
        return jsonResponse({ status: 1, request: "task-123" });
      }
      pollCount += 1;
      if (pollCount === 1) {
        return jsonResponse({ status: 0, request: "CAPCHA_NOT_READY" });
      }
      return jsonResponse({ status: 1, request: "solved-token" });
    });

    const result = await solveCaptcha({
      type: "hcaptcha",
      siteKey: "site-key",
      pageUrl: "https://example.com",
      isInvisible: true,
      fetchImpl,
    });

    expect(result).toEqual({ token: "solved-token", provider: "2captcha", ms: expect.any(Number) });
    expect(calls[0]?.url).toBe("https://2captcha.com/in.php");
    expect(pollCount).toBe(2);
  }, 30000);

  it("rejects with a distinct error when no provider key is configured, without calling fetch", async () => {
    configRef.value = { scraper: { twoCaptchaApiKey: undefined } };
    const fetchImpl = vi.fn();

    await expect(
      solveCaptcha({
        type: "hcaptcha",
        siteKey: "site-key",
        pageUrl: "https://example.com",
        isInvisible: true,
        fetchImpl,
      })
    ).rejects.toSatisfy((err: unknown) => isCaptchaSolverUnavailableError(err));

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("propagates a provider error response as a typed CaptchaError", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith("/in.php")) {
        return jsonResponse({ status: 0, request: "ERROR_WRONG_USER_KEY" });
      }
      throw new Error("should not poll after createTask rejection");
    });

    await expect(
      solveCaptcha({
        type: "hcaptcha",
        siteKey: "site-key",
        pageUrl: "https://example.com",
        isInvisible: true,
        fetchImpl,
      })
    ).rejects.toThrow(/2captcha createTask rejected/);
  });

  it("never logs the configured API key or the resolved token", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith("/in.php")) {
        return jsonResponse({ status: 1, request: "task-123" });
      }
      return jsonResponse({ status: 1, request: "solved-token" });
    });

    await solveCaptcha({
      type: "hcaptcha",
      siteKey: "site-key",
      pageUrl: "https://example.com",
      isInvisible: true,
      fetchImpl,
    });

    const loggedText = [...loggerStub.info.mock.calls, ...loggerStub.error.mock.calls]
      .flat()
      .join(" ");
    expect(loggedText).not.toContain("test-2captcha-key");
    expect(loggedText).not.toContain("solved-token");
  });
});
