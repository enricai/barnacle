import { describe, expect, it } from "vitest";

import {
  decideReplanNoProgress,
  isReplanReproposingFailedStep,
  MAX_TRANSIENT_STEP_RETRIES,
  type NormalizedStep,
} from "@/scripts/recon-browser";

/**
 * Pins the replan-level guard: a provider blip must not be handled as a
 * verdict about the step, but a real selector failure must still abort at
 * once. Exercises the exported decision helper main() calls.
 */

const STEP = "Click the 'Submit Application' button";
const TRANSIENT = [
  { errorMessage: "An internal server error occurred" },
  { errorMessage: "An internal server error occurred" },
];
const SELECTOR = [{ errorMessage: "selector not found" }];

const mk = (instruction: string): NormalizedStep => ({
  instruction,
  optional: false,
  upload: false,
  origin: "replan",
});

describe("decideReplanNoProgress", () => {
  it("allows two bounded re-runs on transient-only attempts, then aborts on the third", () => {
    const counts = new Map<string, number>();
    const steps = [mk(STEP)];
    expect(MAX_TRANSIENT_STEP_RETRIES).toBe(2);
    expect(decideReplanNoProgress(steps, STEP, TRANSIENT, counts)).toBe("retry");
    expect(decideReplanNoProgress(steps, STEP, TRANSIENT, counts)).toBe("retry");
    expect(decideReplanNoProgress(steps, STEP, TRANSIENT, counts)).toBe("abort");
  });

  it("aborts immediately when an attempt carries a non-transient error", () => {
    const counts = new Map<string, number>();
    expect(decideReplanNoProgress([mk(STEP)], STEP, SELECTOR, counts)).toBe("abort");
    expect(counts.size).toBe(0);
  });

  it("aborts on mixed, empty or missing attempt dumps", () => {
    const steps = [mk(STEP)];
    const mixed = [...TRANSIENT, ...SELECTOR];
    expect(decideReplanNoProgress(steps, STEP, mixed, new Map())).toBe("abort");
    expect(decideReplanNoProgress(steps, STEP, [], new Map())).toBe("abort");
    expect(decideReplanNoProgress(steps, STEP, null, new Map())).toBe("abort");
  });

  it("proceeds without consuming retries when the replan adds a new step", () => {
    const counts = new Map<string, number>();
    const steps = [mk("Dismiss the cookie banner"), mk(STEP)];
    expect(decideReplanNoProgress(steps, STEP, TRANSIENT, counts)).toBe("proceed");
    expect(counts.size).toBe(0);
  });

  it("leaves isReplanReproposingFailedStep unchanged for non-transient causes", () => {
    expect(isReplanReproposingFailedStep([mk(STEP)], STEP)).toBe(true);
    expect(isReplanReproposingFailedStep([mk("Dismiss the cookie banner"), mk(STEP)], STEP)).toBe(
      false
    );
    expect(isReplanReproposingFailedStep([], STEP)).toBe(false);
  });
});
