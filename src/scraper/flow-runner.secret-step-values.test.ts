import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Page, Stagehand } from "@browserbasehq/stagehand";
import { afterEach, describe, expect, it, vi } from "vitest";

process.env.RECON_RUN_ID = "flow-runner-secret-step-values-test";
process.env.RECON_OUT_DIR = mkdtempSync(join(tmpdir(), "recon-secret-step-values-"));

import {
  redactPii,
  registerSensitiveValues,
  resetSensitiveValuesForTests,
} from "@/lib/pii-redaction";
import { StepVerificationError } from "@/scraper/errors";
import { runHealingFlow } from "@/scraper/flow-runner";
import type { Logger } from "@/types/logging";

/**
 * `runHealingFlow`'s `secrets` let a plugin type a stable credential (a password
 * a later run must sign in with): the value is registered before the first
 * step, so Stagehand receives it only as a `%token%` variable, error messages
 * and logs carry `<Secret>`, and nothing has to remember to register it first.
 */

const SECRET = "Pw-stable-123!";

const testLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

function makeFakePage(): Page {
  return {
    evaluate: vi.fn().mockResolvedValue(null),
    url: () => "https://apply.example.com/account",
    title: vi.fn().mockResolvedValue(""),
    goto: vi.fn().mockResolvedValue(undefined),
    locator: vi.fn().mockReturnValue({
      first: () => ({
        isChecked: vi.fn().mockResolvedValue(false),
        inputValue: vi.fn().mockResolvedValue(""),
      }),
    }),
    waitForTimeout: vi.fn().mockResolvedValue(undefined),
    frames: () => [],
    getSessionForFrame: () => ({ on: () => {}, off: () => {} }),
    mainFrameId: () => "main",
    sendCDP: vi.fn().mockResolvedValue({ body: "{}", base64Encoded: false }),
  } as unknown as Page;
}

afterEach(() => {
  resetSensitiveValuesForTests();
});

async function failingRun(secrets?: readonly string[]): Promise<{
  failure: unknown;
  act: ReturnType<typeof vi.fn>;
  observe: ReturnType<typeof vi.fn>;
}> {
  const act = vi.fn().mockResolvedValue({ success: false, message: "", actions: [] });
  const observe = vi.fn().mockResolvedValue([]);
  const failure = await runHealingFlow({
    stagehand: { act, observe } as unknown as Stagehand,
    page: makeFakePage(),
    steps: [
      {
        instruction: `Fill in the Password field with '${SECRET}'`,
        optional: false,
        upload: false,
        submitStep: false,
      },
    ],
    logger: testLogger,
    anthropic: null,
    rephraseModel: null,
    uploadFixture: null,
    ...(secrets ? { secrets } : {}),
  }).catch((err: unknown) => err);
  return { failure, act, observe };
}

describe("flow-runner/runHealingFlow — secrets", () => {
  it("leaks the literal without `secrets` (control: the assertions below can fail)", async () => {
    const { failure } = await failingRun();
    expect((failure as Error).message).toContain(SECRET);
  });

  it("registers the secrets before the first step, so the failure message carries <Secret>", async () => {
    const { failure, act, observe } = await failingRun([SECRET]);

    expect(failure).toBeInstanceOf(StepVerificationError);
    expect((failure as Error).message).not.toContain(SECRET);
    expect((failure as Error).message).toContain("<Secret>");
    expect(redactPii(`typed ${SECRET}`)).toBe("typed <Secret>");
    expect(act.mock.calls.length + observe.mock.calls.length).toBeGreaterThan(0);
    for (const [instruction, options] of act.mock.calls as [unknown, unknown][]) {
      expect(JSON.stringify(instruction)).not.toContain(SECRET);
      if (typeof instruction === "string" && instruction.includes("%")) {
        expect(JSON.stringify(options)).toContain(SECRET);
      }
    }
    for (const [instruction] of observe.mock.calls as [unknown][]) {
      expect(JSON.stringify(instruction)).not.toContain(SECRET);
    }
  });

  it("redacts request values in the failure message before truncating it", async () => {
    registerSensitiveValues(
      "run-trunc",
      { Email: "nurse.long-address-1234@inbox.example.com" },
      {
        wordKeys: ["Email"],
      }
    );
    const act = vi.fn().mockResolvedValue({ success: false, message: "", actions: [] });
    const failure = await runHealingFlow({
      stagehand: { act, observe: vi.fn().mockResolvedValue([]) } as unknown as Stagehand,
      page: makeFakePage(),
      steps: [
        {
          // The 60-char cut lands mid-address: a truncated value no longer matches
          // the registered literal, so it must be redacted before the cut.
          instruction: "Fill in the Email field with 'nurse.long-address-1234@inbox.example.com'",
          optional: false,
          upload: false,
          submitStep: false,
        },
      ],
      logger: testLogger,
      anthropic: null,
      rephraseModel: null,
      uploadFixture: null,
    }).catch((err: unknown) => err);
    expect((failure as Error).message).not.toContain("nurse.long-address");
    expect((failure as Error).message).toContain("<Email>");
  });
});
