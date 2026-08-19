import type { Page, Stagehand } from "@browserbasehq/stagehand";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { probeStepBeforeAttempts } from "@/scraper/flow-runner";
import type { Logger } from "@/types/logging";

/**
 * Regression coverage for docs/recon-1126-midstep-session-death-swallowed-by-flowrunner-probe.md:
 * `probeStepBeforeAttempts`'s three "treat as present" fallback branches
 * (unfocused-observe-present, deepLocator-present, and probe-threw) must not
 * swallow a closed/dead session as a benign reachability miss — a dead
 * session has to surface as `SessionTimeoutError`, not "present".
 */

const guardedObserve = vi.fn();

vi.mock("@/scraper/stagehand-guard", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/scraper/stagehand-guard")>();
  return {
    ...actual,
    guardedObserve: (...args: unknown[]) => guardedObserve(...args),
  };
});

const testLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

function makeStagehand(): Stagehand {
  return {} as unknown as Stagehand;
}

/** Fake `Page` whose `url()` throws, modeling a closed/dead session at the moment a swallow branch would otherwise fire. */
function makeDeadPage(): Page {
  return {
    url: () => {
      throw new Error("Target page, context or browser has been closed");
    },
  } as unknown as Page;
}

describe("flow-runner/probeStepBeforeAttempts — mid-probe session death", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("throws SessionTimeoutError instead of returning present when the session is dead at the unfocused-observe-present branch", async () => {
    guardedObserve
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ selector: "input#f", description: "field", method: "fill" }]);

    await expect(
      probeStepBeforeAttempts({
        stagehand: makeStagehand(),
        page: makeDeadPage(),
        step: "Fill in the field",
        stepIndex: 0,
        logger: testLogger,
      })
    ).rejects.toThrow(/session appears closed\/dead/);
  });

  it("throws SessionTimeoutError instead of returning present when the session is dead at the probe-threw catch branch", async () => {
    guardedObserve.mockRejectedValueOnce(new Error("observe timed out"));

    await expect(
      probeStepBeforeAttempts({
        stagehand: makeStagehand(),
        page: makeDeadPage(),
        step: "Fill in the field",
        stepIndex: 0,
        logger: testLogger,
      })
    ).rejects.toThrow(/session appears closed\/dead/);
  });

  it("returns present as before when the session is alive (control case)", async () => {
    guardedObserve
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ selector: "input#f", description: "field", method: "fill" }]);
    const page = { url: () => "https://example.org/apply" } as unknown as Page;

    const result = await probeStepBeforeAttempts({
      stagehand: makeStagehand(),
      page,
      step: "Fill in the field",
      stepIndex: 0,
      logger: testLogger,
    });

    expect(result).toBe("present");
  });
});
