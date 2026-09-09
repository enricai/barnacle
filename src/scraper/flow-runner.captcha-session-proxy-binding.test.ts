import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Page, Stagehand } from "@browserbasehq/stagehand";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

process.env.RECON_RUN_ID = "flow-runner-captcha-session-proxy-binding-test";
process.env.RECON_OUT_DIR = mkdtempSync(join(tmpdir(), "recon-captcha-session-proxy-binding-"));

const { solveCaptchaMock } = vi.hoisted(() => ({ solveCaptchaMock: vi.fn() }));
vi.mock("@/scraper/captcha-solver", () => ({ solveCaptcha: solveCaptchaMock }));

import { executeStepWithHealing } from "@/scraper/flow-runner";
import { resolveReconRunDir } from "@/scripts/recon-shared";
import type { Logger } from "@/types/logging";
import type { SessionProxyTuple } from "@/types/session-proxy";

/**
 * Locks in required item 2 from the recon root cause: the session's resolved
 * proxy egress tuple must reach the captchaGated `solveCaptcha` call so the
 * token is minted on the same IP that submits it.
 */

const testLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

function baseParams(
  page: Page,
  stagehand: Stagehand
): Parameters<typeof executeStepWithHealing>[0] {
  return {
    stagehand,
    page,
    step: "Solve the captcha and submit the application",
    optional: false,
    upload: false,
    submitStep: true,
    captchaGated: true,
    flowHasSubmitSemantics: true,
    stepIndex: 0,
    phase: "apply",
    signalCounter: { n: 0 },
    recentCaptures: [] as string[],
    recentCaptureMeta: [] as { method: string; status: number; url: string }[],
    anthropic: null,
    rephraseModel: null,
    logger: testLogger,
    captureFn: vi.fn().mockResolvedValue(undefined),
    uploadFixture: null,
    isFinalStep: true,
    submitEndpointPattern: null,
    submittedStateSelectors: [] as string[],
    requireSubmitEndpointMatch: false,
    advanceTransitionBodyPattern: "type=next",
    successUrlFragments: [] as string[],
    successPageTitleHints: [] as string[],
    ownBackendHostnames: [] as string[],
    knownErrorClassPrefixes: [] as string[],
    wizardExitButtonLabels: [] as string[],
  };
}

function makeSimplePage(): Page {
  const evaluate = vi.fn().mockImplementation(async (expr: unknown) => {
    const src = String(expr);
    if (src.includes("hasForm")) {
      return { injected: true, hasForm: true, callbackDiscovered: false };
    }
    if (src.includes('return "absent"')) return "absent";
    if (src.includes("getAttribute")) {
      return { siteKey: "10000000-ffff-ffff-ffff-000000000001", isInvisible: true };
    }
    if (src === "navigator.userAgent") return "test-agent/1.0";
    if (src.includes("dispatchEvent")) return undefined;
    if (src.includes("requestSubmit")) return undefined;
    if (src.includes("outerHTML")) return { html: 0, text: "0:" };
    if (src.includes("isInvalid(el)")) return 0;
    return null;
  });

  return {
    evaluate,
    url: () => "https://apply.example.com/application/abc-123",
    title: vi.fn().mockResolvedValue(""),
    locator: vi.fn().mockReturnValue({
      first: () => ({
        isChecked: vi.fn().mockResolvedValue(false),
        inputValue: vi.fn().mockResolvedValue(""),
      }),
    }),
    waitForTimeout: vi.fn().mockResolvedValue(undefined),
  } as unknown as Page;
}

describe("flow-runner/executeStepWithHealing — captchaGated session proxy binding", () => {
  let capturesDir: string;

  beforeAll(() => {
    capturesDir = resolveReconRunDir().graphqlDir;
  });

  beforeEach(() => {
    solveCaptchaMock.mockReset();
    rmSync(capturesDir, { recursive: true, force: true });
    mkdirSync(capturesDir, { recursive: true });
  });

  it("threads the session's resolved proxy egress tuple into solveCaptcha's proxy argument", async () => {
    solveCaptchaMock.mockResolvedValue({ token: "solved-token", provider: "2captcha", ms: 12 });
    const page = makeSimplePage();
    writeFileSync(
      join(capturesDir, "001-submit-real.json"),
      JSON.stringify({
        requestPostData: "type=next&step=review",
        variables: { input: { type: "next" } },
      })
    );
    const stagehand = {} as Stagehand;
    const sessionProxy: SessionProxyTuple = {
      protocol: "socks5",
      host: "residential.example.net",
      port: 1080,
      username: "solve-user",
      password: "solve-pass",
    };

    const result = await executeStepWithHealing({
      ...baseParams(page, stagehand),
      sessionProxy,
    });

    expect(result).toBe("completed");
    expect(solveCaptchaMock).toHaveBeenCalledWith(expect.objectContaining({ proxy: sessionProxy }));
  });

  it("calls solveCaptcha without a proxy field when the session exposes no resolvable proxy", async () => {
    solveCaptchaMock.mockResolvedValue({ token: "solved-token", provider: "2captcha", ms: 12 });
    const page = makeSimplePage();
    writeFileSync(
      join(capturesDir, "001-submit-real.json"),
      JSON.stringify({
        requestPostData: "type=next&step=review",
        variables: { input: { type: "next" } },
      })
    );
    const stagehand = {} as Stagehand;

    const result = await executeStepWithHealing(baseParams(page, stagehand));

    expect(result).toBe("completed");
    expect(solveCaptchaMock).toHaveBeenCalledWith({
      type: "hcaptcha",
      siteKey: "10000000-ffff-ffff-ffff-000000000001",
      pageUrl: "https://apply.example.com/application/abc-123",
      isInvisible: true,
      userAgent: "test-agent/1.0",
    });
  });
});
