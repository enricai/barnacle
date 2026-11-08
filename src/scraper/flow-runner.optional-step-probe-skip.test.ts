import type { Page, Stagehand } from "@browserbasehq/stagehand";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { probeStepBeforeAttempts } from "@/scraper/flow-runner";
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

  it("conditional click step, optional=false -> absent after one observe", async () => {
    expect(await run("If the newsletter dialog is visible, click Close", false)).toBe("absent");
    expect(guardedObserve).toHaveBeenCalledTimes(1);
  });

  it("conditional fill step keeps unfocused fallback", async () => {
    expect(
      await run("If the newsletter dialog is visible, fill in the 'Email' field with 'a@b.co'", false)
    ).toBe("present");
  });
});
