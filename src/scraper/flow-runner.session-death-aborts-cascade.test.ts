import type { Page, Stagehand } from "@browserbasehq/stagehand";
import { describe, expect, it, vi } from "vitest";

import { executeStepWithHealing } from "@/scraper/flow-runner";
import type { Logger } from "@/types/logging";

const testLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

function buildParams(abortSignal?: AbortSignal) {
  const act = vi
    .fn()
    .mockResolvedValue({ success: false, message: "", actionDescription: "", actions: [] });
  const observe = vi
    .fn()
    .mockResolvedValue([
      { selector: "xpath=//button", description: "mystery widget", method: "click", arguments: [] },
    ]);
  const stagehand = { act, observe } as unknown as Stagehand;
  const page = {
    url: () => "https://example.test/",
    evaluate: vi.fn().mockResolvedValue(null),
  } as unknown as Page;
  return {
    act,
    observe,
    params: {
      stagehand,
      page,
      abortSignal,
      step: "Click the mystery widget",
      optional: false,
      upload: false,
      submitStep: false,
      stepIndex: 0,
      phase: "flow",
      signalCounter: { n: 0 },
      recentCaptures: [],
      recentCaptureMeta: [],
      anthropic: null,
      rephraseModel: null,
      logger: testLogger,
      captureFn: vi.fn().mockResolvedValue(undefined),
      uploadFixture: null,
      isFinalStep: false,
      flowHasSubmitSemantics: false,
      submitEndpointPattern: null,
      submittedStateSelectors: [],
      requireSubmitEndpointMatch: false,
      advanceTransitionBodyPattern: null,
      successUrlFragments: [],
      successPageTitleHints: [],
      ownBackendHostnames: [],
      knownErrorClassPrefixes: [],
      wizardExitButtonLabels: [],
    },
  };
}

describe("flow-runner/executeStepWithHealing session-death abort", () => {
  it("rejects with the death reason and makes no act calls and no cascade observe calls when the signal is already aborted", async () => {
    const death = new Error("SessionLifetimeExpired: session reached its configured lifetime");
    const controller = new AbortController();
    controller.abort(death);
    const { act, observe, params } = buildParams(controller.signal);

    await expect(executeStepWithHealing(params)).rejects.toBe(death);
    expect(act).not.toHaveBeenCalled();
    expect(observe.mock.calls.length).toBeLessThanOrEqual(1);
  });
});
