import type { Page, Stagehand } from "@browserbasehq/stagehand";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { probeStepBeforeAttempts } from "@/scraper/flow-runner";
import {
  applyFailedStepFlagsToResumingBridgeStep,
  filterReplanDuplicatingNextAuthored,
  seedSubmitStepFromOwnInstructionText,
  type NormalizedStep,
} from "@/scripts/recon-browser";
import type { Logger } from "@/types/logging";

const guardedObserve = vi.fn();

vi.mock("@/scraper/stagehand-guard", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/scraper/stagehand-guard")>();
  return { ...actual, guardedObserve: (...a: unknown[]) => guardedObserve(...a) };
});

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;
const page = { url: () => "https://example.org/" } as unknown as Page;

function run(step: string, optional?: boolean) {
  return probeStepBeforeAttempts({
    stagehand: {} as Stagehand,
    page,
    step,
    stepIndex: 0,
    logger,
    optional,
  });
}

describe("probeStepBeforeAttempts optional click-shaped step", () => {
  beforeEach(() => {
    guardedObserve.mockReset();
    // focused (instruction defined) -> 0; unfocused -> 3
    guardedObserve.mockImplementation(async (_s, instruction) =>
      instruction === undefined ? [{}, {}, {}] : []
    );
  });

  it("optional click step, 0 focused / N unfocused -> absent, no unfocused observe", async () => {
    expect(await run("Click the 'Dismiss' button", true)).toBe("absent");
    expect(guardedObserve).toHaveBeenCalledTimes(1);
  });

  it("required click step keeps treat-as-present", async () => {
    expect(await run("Click the 'Dismiss' button", false)).toBe("present");
    expect(guardedObserve).toHaveBeenCalledTimes(2);
  });

  it("optional fill step keeps unfocused fallback", async () => {
    expect(await run("Fill in the 'Email' field with 'a@b.co'", true)).toBe("present");
  });

  it("replan-bridge optional step, 0 focused -> absent, no 'treating as present' cascade", async () => {
    vi.mocked(logger.info).mockClear();
    const bridge = { instruction: "Click the 'Add Experience' button", optional: true, origin: "replan" };
    expect(await run(bridge.instruction, bridge.optional)).toBe("absent");
    const logged = (logger.info as unknown as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0]));
    expect(logged.some((m) => m.includes("treating as present ("))).toBe(false);
    expect(logged.some((m) => m.includes("treating as absent"))).toBe(true);
  });

  it("step spliced via real recon-browser replan helpers keeps optional and probes absent", async () => {
    const mk = (instruction: string, optional: boolean, origin: "original" | "replan"): NormalizedStep => ({
      instruction,
      optional,
      upload: false,
      origin,
    });
    const failed = mk("Click the 'Add Experience' button", false, "original");
    const remaining = [mk("Click the 'Continue' button", false, "original")];
    const survivors = filterReplanDuplicatingNextAuthored(
      [mk("Click the 'Add Experience' button", true, "replan")],
      remaining
    );
    const [bridge] = seedSubmitStepFromOwnInstructionText(
      applyFailedStepFlagsToResumingBridgeStep(survivors, failed)
    );
    expect(bridge?.origin).toBe("replan");
    expect(bridge?.optional).toBe(true);
    expect(await run(bridge!.instruction, bridge!.optional)).toBe("absent");
  });
});
