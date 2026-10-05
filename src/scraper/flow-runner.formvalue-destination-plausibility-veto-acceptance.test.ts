import type { Page, Stagehand } from "@browserbasehq/stagehand";
import { describe, expect, it, vi } from "vitest";
import { type HealingFlowStep, runHealingFlow } from "@/scraper/flow-runner";
import type { Logger } from "@/types/logging";

/**
 * Pins bugfix-004 (recon-n16-weakdomsignals-credit-has-no-destination-
 * plausibility-gate.md): the attempt-1 `formValueVerified = isStateClass &&
 * formValueWeakSignalAllowed && post.formValueSignature !==
 * pre.formValueSignature` credit is a page-wide form-value-signature delta
 * with no URL/destination input at all — same ungated shape as the n+16
 * fallback's `retryFormValueChanged` disjunct (covered by bugfix-002), just
 * on the attempt-1 path. A fill step whose act() lands on a sign-in-shaped
 * destination (the session was bounced to an auth gate) must not be
 * credited from the form-value-signature delta alone, even though the
 * signature genuinely changed.
 */

const BASE_URL = "https://apply.example.com/step/1";
const FILL_STEP = "Fill in the middle name field";

interface SequenceState {
  url: string;
  values: string;
}

function makeLogger(): { logger: Logger; info: string[] } {
  const info: string[] = [];
  const logger = {
    info: vi.fn((msg: string) => info.push(msg)),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as unknown as Logger;
  return { logger, info };
}

function makePage(state: SequenceState): Page {
  const session = { on: () => {}, off: () => {} };
  return {
    evaluate: async (expr: unknown) => {
      const src = String(expr);
      if (src.includes("outerHTML") && src.includes("innerText")) {
        return { html: 1000, text: "1000:unchanged", values: state.values };
      }
      if (src.includes("isInvalid(el)")) return 0;
      return null;
    },
    url: () => state.url,
    title: async () => "Apply",
    locator: () => ({
      first: () => ({
        isChecked: async () => false,
        // Deliberately never matches the fill's argument, so
        // verifyDomEffect's own read-back is always false and the only
        // candidate credit path for the step is formValueVerified.
        inputValue: async () => "",
      }),
    }),
    waitForTimeout: async () => {},
    getSessionForFrame: () => session,
    mainFrameId: () => "main",
    sendCDP: async () => ({ body: "{}", base64Encoded: false }),
  } as unknown as Page;
}

function makeStagehand(state: SequenceState, destinationUrl: string): Stagehand {
  return {
    act: vi.fn().mockImplementation(async () => {
      state.url = destinationUrl;
      state.values = "middle-name=Lee";
      return {
        success: true,
        message: "filled",
        actionDescription: FILL_STEP,
        actions: [
          {
            selector: "css=#middleName",
            description: "Middle name field",
            method: "fill",
            arguments: ["Lee"],
          },
        ],
      };
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

function buildSteps(): HealingFlowStep[] {
  return [{ instruction: FILL_STEP, optional: false, upload: false, submitStep: false }];
}

describe("flow-runner attempt-1 formValueVerified — gated by destination plausibility", () => {
  it("does NOT credit a form-value-signature change alone when the step lands on a sign-in-shaped destination unrelated to its own instruction", async () => {
    const state: SequenceState = { url: BASE_URL, values: "middle-name=" };
    const stagehand = makeStagehand(state, "https://apply.example.com/sign-in");
    const page = makePage(state);
    const { logger, info } = makeLogger();

    await expect(
      runHealingFlow({
        stagehand,
        page,
        steps: buildSteps(),
        logger,
        anthropic: null,
        rephraseModel: null,
        uploadFixture: null,
      })
    ).rejects.toBeTruthy();

    expect(info.some((line) => line.includes("succeeded on attempt 1"))).toBe(false);
  });

  it("positive control: the same form-value-signature change still credits verified when the destination is plausible", async () => {
    const state: SequenceState = { url: BASE_URL, values: "middle-name=" };
    const stagehand = makeStagehand(state, BASE_URL);
    const page = makePage(state);
    const { logger, info } = makeLogger();

    const result = await runHealingFlow({
      stagehand,
      page,
      steps: buildSteps(),
      logger,
      anthropic: null,
      rephraseModel: null,
      uploadFixture: null,
    });

    expect(result.lastStepIndex).toBe(0);
    expect(info.some((line) => line.includes("succeeded on attempt 1"))).toBe(true);
  });
});
