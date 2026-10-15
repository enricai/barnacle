import type { Page, Stagehand } from "@browserbasehq/stagehand";
import { describe, expect, it, vi } from "vitest";
import { type HealingFlowStep, runHealingFlow } from "@/scraper/flow-runner";
import type { Logger } from "@/types/logging";

const BASE_URL = "https://example-onboarding.example.com/apply/terms";
const STEP = "Click the 'I agree' checkbox";

const SILENT_LOGGER = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as unknown as Logger;

interface CheckboxFixture {
  ariaChecked: string | null;
  ancestorInvalid: boolean;
}

function makePage(fx: CheckboxFixture): Page {
  const session = { on: () => {}, off: () => {} };
  return {
    evaluate: async (expr: unknown) => {
      const src = String(expr);
      if (src.includes("isDisabled")) return false;
      if (src.includes("el.type || null")) return "checkbox";
      if (src.includes('getAttribute("aria-checked")')) return fx.ariaChecked;
      if (src.includes("depth < 6")) return fx.ancestorInvalid;
      if (src.includes("outerHTML") && src.includes("innerText")) {
        return { html: 1000, text: "1000:" };
      }
      if (src.includes("isInvalid(el)")) return 0;
      return null;
    },
    url: () => BASE_URL,
    title: async () => "Terms",
    locator: () => ({
      first: () => ({ isChecked: async () => true, inputValue: async () => "" }),
    }),
    waitForTimeout: async () => {},
    getSessionForFrame: () => session,
    mainFrameId: () => "main",
    sendCDP: async () => ({ body: "{}", base64Encoded: false }),
  } as unknown as Page;
}

function makeStagehand(): Stagehand {
  return {
    act: vi.fn().mockResolvedValue({
      success: true,
      message: "clicked",
      actionDescription: STEP,
      actions: [
        {
          selector: "xpath=//input[@id='agree']",
          description: "I agree",
          method: "click",
        },
      ],
    }),
    observe: vi
      .fn()
      .mockImplementation(async (instruction?: unknown) =>
        typeof instruction === "string"
          ? []
          : [{ selector: "xpath=//probe-presence", description: "probe-presence" }]
      ),
  } as unknown as Stagehand;
}

const STEPS: HealingFlowStep[] = [
  { instruction: STEP, optional: false, upload: false, submitStep: false },
];

async function run(fx: CheckboxFixture): Promise<void> {
  await runHealingFlow({
    stagehand: makeStagehand(),
    page: makePage(fx),
    steps: STEPS,
    logger: SILENT_LOGGER,
    anthropic: null,
    rephraseModel: null,
    uploadFixture: null,
  });
}

describe("verifyDomEffect checkbox credit signal (offline fixture)", () => {
  it("credits aria-checked=true despite a stale invalid ancestor", async () => {
    await expect(run({ ariaChecked: "true", ancestorInvalid: true })).resolves.toBeUndefined();
  });

  it("does not credit aria-checked=false", async () => {
    await expect(run({ ariaChecked: "false", ancestorInvalid: false })).rejects.toMatchObject({
      name: "StepVerificationError",
    });
  });

  it("still rejects a native checkbox whose ancestor stays invalid", async () => {
    await expect(run({ ariaChecked: null, ancestorInvalid: true })).rejects.toMatchObject({
      name: "StepVerificationError",
    });
  });
});
