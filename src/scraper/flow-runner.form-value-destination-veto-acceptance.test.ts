import type { Page, Stagehand } from "@browserbasehq/stagehand";
import { describe, expect, it, vi } from "vitest";
import { type HealingFlowStep, runHealingFlow } from "@/scraper/flow-runner";
import type { Logger } from "@/types/logging";

/**
 * Pins the attempt-1 `formValueVerified` credit (flow-runner.ts ~12107-
 * 12111) behind `isPlausibleStepDestination`: the signal is a page-wide
 * `formValueSignature` delta with no URL/destination input of its own, so
 * an isStateClass fill whose underlying act both commits a value AND lands
 * on an implausible destination (a sign-in-shaped page unrelated to the
 * step's own instruction) must not ride the bare signature delta to
 * "verified". Exercises an autocomplete-commit shape — a combobox option
 * pick that both writes the field's value and redirects — distinct from the
 * plain `<input>` fixture in
 * flow-runner.formvalue-destination-plausibility-veto-acceptance.test.ts so
 * the isStateClass (fill) branch is covered on its own fixture shape, not
 * re-asserted on an identical one.
 */

const BASE_URL = "https://apply.example.com/step/1";
const FILL_STEP = "Select the country from the autocomplete field";

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
        // Never matches the committed autocomplete value, so
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
      state.values = "country=Canada";
      return {
        success: true,
        message: "selected",
        actionDescription: FILL_STEP,
        actions: [
          {
            selector: "css=#country-autocomplete-option-ca",
            description: "Canada option",
            method: "fill",
            arguments: ["Canada"],
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

describe("flow-runner isStateClass formValueVerified — gated by destination plausibility", () => {
  it("does NOT credit an autocomplete-commit form-value-signature change alone when the step bounces to a sign-in-shaped destination unrelated to its own instruction", async () => {
    const state: SequenceState = { url: BASE_URL, values: "country=" };
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

  it("regression: the identical autocomplete-commit form-value-signature change still credits verified when the destination stays plausible", async () => {
    const state: SequenceState = { url: BASE_URL, values: "country=" };
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
