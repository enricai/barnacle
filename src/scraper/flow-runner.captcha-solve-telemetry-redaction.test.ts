/**
 * Proves the captcha-gated submit hook's solve path (`solveCaptcha`) emits an
 * auditable telemetry marker for both a successful and a failed attempt, and
 * that no captured log line anywhere on that path leaks the raw provider API
 * key or the solved token.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { FAKE_API_KEY, FAKE_SOLVED_TOKEN, configRef } = vi.hoisted(() => {
  const apiKey = "2c-key-x7q9v3n5m1p8w2r6t4y0z";
  const solvedToken = "hct-a4f8e1c9b3d76025-solved-9k3jf7q1";
  return {
    FAKE_API_KEY: apiKey,
    FAKE_SOLVED_TOKEN: solvedToken,
    configRef: { value: { scraper: { twoCaptchaApiKey: apiKey as string | undefined } } },
  };
});
vi.mock("@/config", () => ({
  get config() {
    return configRef.value;
  },
}));

// Hoist-safe capturing stub matching the Logger interface (retry.test.ts /
// captcha-solver.test.ts pattern) so we assert against real log output
// instead of spying on the real pino instance.
const { capturedLines, loggerStub } = vi.hoisted(() => {
  const lines: string[] = [];
  return {
    capturedLines: lines,
    loggerStub: {
      info: vi.fn((msg: string) => lines.push(msg)),
      warn: vi.fn((msg: string) => lines.push(msg)),
      error: vi.fn((msg: string) => lines.push(msg)),
      debug: vi.fn((msg: string) => lines.push(msg)),
      errorWithStack: vi.fn((msg: string) => lines.push(msg)),
    },
  };
});
vi.mock("@/lib/logging", () => ({ getLogger: () => loggerStub }));

import { solveCaptcha } from "@/scraper/captcha-solver";

function jsonResponse(body: unknown): {
  status: number;
  headers: Headers;
  text: () => Promise<string>;
} {
  return { status: 200, headers: new Headers(), text: () => Promise.resolve(JSON.stringify(body)) };
}

describe("captcha-gated submit hook — solve telemetry marker + secret redaction", () => {
  beforeEach(() => {
    configRef.value = { scraper: { twoCaptchaApiKey: FAKE_API_KEY } };
    capturedLines.length = 0;
    vi.clearAllMocks();
  });

  it("emits a provider/ms/ok telemetry marker on success and never leaks the key or solved token", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith("/in.php")) return jsonResponse({ status: 1, request: "task-abc" });
      return jsonResponse({ status: 1, request: FAKE_SOLVED_TOKEN });
    });

    const result = await solveCaptcha({
      type: "hcaptcha",
      siteKey: "site-key",
      pageUrl: "https://example.com/apply",
      isInvisible: true,
      fetchImpl,
    });

    expect(result.token).toBe(FAKE_SOLVED_TOKEN);
    expect(capturedLines).toContainEqual(
      expect.stringMatching(/^captcha-solve: provider=2captcha ms=\d+ ok=true$/)
    );

    const allLogText = capturedLines.join(" ");
    expect(allLogText).not.toContain(FAKE_API_KEY);
    expect(allLogText).not.toContain(FAKE_SOLVED_TOKEN);
  });

  it("emits a provider/ms/ok=false telemetry marker on a failed attempt and never leaks the key", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith("/in.php"))
        return jsonResponse({ status: 0, request: "ERROR_WRONG_USER_KEY" });
      throw new Error("should not poll after createTask rejection");
    });

    await expect(
      solveCaptcha({
        type: "hcaptcha",
        siteKey: "site-key",
        pageUrl: "https://example.com/apply",
        isInvisible: true,
        fetchImpl,
      })
    ).rejects.toThrow(/2captcha createTask rejected/);

    expect(capturedLines).toContainEqual(
      expect.stringMatching(/^captcha-solve: provider=2captcha ms=\d+ ok=false$/)
    );

    const allLogText = capturedLines.join(" ");
    expect(allLogText).not.toContain(FAKE_API_KEY);
    expect(allLogText).not.toContain(FAKE_SOLVED_TOKEN);
  });
});
