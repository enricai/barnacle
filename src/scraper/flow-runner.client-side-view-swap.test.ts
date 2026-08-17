import { describe, expect, it } from "vitest";

import { isClickViewSwapVerified } from "@/scraper/flow-runner";

describe("flow-runner/isClickViewSwapVerified — client-side view-swap gate", () => {
  /**
   * Case 1: A non-advance, non-final click step with large DOM growth
   * (+~49KB, matching the top-window site Manual Application measurement) and
   * zero network is credited as verified=true.
   */
  it("credits a plain click with large DOM growth (≥5KB) and zero network as verified", () => {
    const result = isClickViewSwapVerified({
      resolvedAction: { method: "click" },
      isFinalStep: false,
      submitStep: false,
      isAdvanceWithPattern: false,
      networkDelta: 0,
      bytesDelta: 49518,
      textChanged: false, // the top-window site "Manual Application" measured delta
    });
    expect(result).toBe(true);
  });

  /**
   * Case 2: The same DOM-growth/zero-network shape on a final/submitStep
   * is NOT credited — submit-judge/isSubmitRevealedInvalid path still governs.
   */
  it("rejects DOM growth on a final step (submit verification requires real network)", () => {
    const result = isClickViewSwapVerified({
      resolvedAction: { method: "click" },
      isFinalStep: true,
      submitStep: false,
      isAdvanceWithPattern: false,
      networkDelta: 0,
      bytesDelta: 49518,
      textChanged: false,
    });
    expect(result).toBe(false);
  });

  it("rejects DOM growth on a submitStep (submit verification requires real network)", () => {
    const result = isClickViewSwapVerified({
      resolvedAction: { method: "click" },
      isFinalStep: false,
      submitStep: true,
      isAdvanceWithPattern: false,
      networkDelta: 0,
      bytesDelta: 49518,
      textChanged: false,
    });
    expect(result).toBe(false);
  });

  /**
   * Case 3: The same shape on an isAdvanceStep with advanceTransitionBodyPattern
   * configured is NOT credited — isDomOnlyAdvanceVerified veto still governs.
   */
  it("rejects DOM growth on an advance-pattern step (advance verification requires real transition)", () => {
    const result = isClickViewSwapVerified({
      resolvedAction: { method: "click" },
      isFinalStep: false,
      submitStep: false,
      isAdvanceWithPattern: true, // advanceTransitionBodyPattern is non-null
      networkDelta: 0,
      bytesDelta: 49518,
      textChanged: false,
    });
    expect(result).toBe(false);
  });

  /**
   * Case 4: A small DOM growth below the reveal threshold (e.g., a tooltip
   * reflow) is NOT credited, preserving the existing dom-grew-without-network
   * failure path for genuine validation-blocked submits.
   */
  it("rejects sub-threshold DOM delta (<5000B, the VIEW_SWAP_MIN_BYTES)", () => {
    const result = isClickViewSwapVerified({
      resolvedAction: { method: "click" },
      isFinalStep: false,
      submitStep: false,
      isAdvanceWithPattern: false,
      networkDelta: 0,
      bytesDelta: 499,
      textChanged: false, // Below TRIVIAL_DOM_DELTA_BYTES (500B)
    });
    expect(result).toBe(false);
  });

  it("rejects DOM delta at exactly the trivial boundary (500B)", () => {
    const result = isClickViewSwapVerified({
      resolvedAction: { method: "click" },
      isFinalStep: false,
      submitStep: false,
      isAdvanceWithPattern: false,
      networkDelta: 0,
      bytesDelta: 500,
      textChanged: false,
    });
    expect(result).toBe(false);
  });

  it("rejects DOM delta at 4999B (1B below the VIEW_SWAP_MIN_BYTES threshold)", () => {
    const result = isClickViewSwapVerified({
      resolvedAction: { method: "click" },
      isFinalStep: false,
      submitStep: false,
      isAdvanceWithPattern: false,
      networkDelta: 0,
      bytesDelta: 4999,
      textChanged: false,
    });
    expect(result).toBe(false);
  });

  it("credits DOM delta at exactly the VIEW_SWAP_MIN_BYTES threshold (5000B)", () => {
    const result = isClickViewSwapVerified({
      resolvedAction: { method: "click" },
      isFinalStep: false,
      submitStep: false,
      isAdvanceWithPattern: false,
      networkDelta: 0,
      bytesDelta: 5000,
      textChanged: false,
    });
    expect(result).toBe(true);
  });

  /**
   * Non-click actions are rejected, even with large DOM growth.
   */
  it("rejects non-click actions (e.g., type, select) even with large DOM growth", () => {
    const result = isClickViewSwapVerified({
      resolvedAction: { method: "type" },
      isFinalStep: false,
      submitStep: false,
      isAdvanceWithPattern: false,
      networkDelta: 0,
      bytesDelta: 49518,
      textChanged: false,
    });
    expect(result).toBe(false);
  });

  it("rejects when resolvedAction is null", () => {
    const result = isClickViewSwapVerified({
      resolvedAction: null,
      isFinalStep: false,
      submitStep: false,
      isAdvanceWithPattern: false,
      networkDelta: 0,
      bytesDelta: 49518,
      textChanged: false,
    });
    expect(result).toBe(false);
  });

  /**
   * If network activity occurred, this is not a pure client-side view swap.
   */
  it("rejects when network activity occurred (networkDelta > 0)", () => {
    const result = isClickViewSwapVerified({
      resolvedAction: { method: "click" },
      isFinalStep: false,
      submitStep: false,
      isAdvanceWithPattern: false,
      networkDelta: 1, // At least one network request
      bytesDelta: 49518,
      textChanged: false,
    });
    expect(result).toBe(false);
  });

  /**
   * Small-delta reveal credit: a validation-triggered section reveal
   * (the top-window site's Work-History gate message, measured +789B with visible text
   * change and zero network) is credited even though it never clears the
   * 5000B full-swap threshold — the exact signal shape logged at
   * oopif-recon-20.log:341. Matches the DESCRIBE_ATTEMPT_EFFECT_SIGNALS
   * dom-grew-without-network diagnostic that used to be this step's only
   * output before it cascaded to a 5-attempt failure and global replan.
   */
  it("credits a small text-changing reveal (+789B, the top-window site Work-History gate) below VIEW_SWAP_MIN_BYTES", () => {
    const result = isClickViewSwapVerified({
      resolvedAction: { method: "click" },
      isFinalStep: false,
      submitStep: false,
      isAdvanceWithPattern: false,
      networkDelta: 0,
      bytesDelta: 789,
      textChanged: true,
    });
    expect(result).toBe(true);
  });

  it("credits a reveal at exactly the VIEW_SWAP_REVEAL_MIN_BYTES threshold (500B) with text change", () => {
    const result = isClickViewSwapVerified({
      resolvedAction: { method: "click" },
      isFinalStep: false,
      submitStep: false,
      isAdvanceWithPattern: false,
      networkDelta: 0,
      bytesDelta: 500,
      textChanged: true,
    });
    expect(result).toBe(true);
  });

  it("rejects a small delta (789B) with no visible text change (trivial reflow, not a reveal)", () => {
    const result = isClickViewSwapVerified({
      resolvedAction: { method: "click" },
      isFinalStep: false,
      submitStep: false,
      isAdvanceWithPattern: false,
      networkDelta: 0,
      bytesDelta: 789,
      textChanged: false,
    });
    expect(result).toBe(false);
  });

  it("rejects a text-changing delta below VIEW_SWAP_REVEAL_MIN_BYTES (499B)", () => {
    const result = isClickViewSwapVerified({
      resolvedAction: { method: "click" },
      isFinalStep: false,
      submitStep: false,
      isAdvanceWithPattern: false,
      networkDelta: 0,
      bytesDelta: 499,
      textChanged: true,
    });
    expect(result).toBe(false);
  });

  it("rejects a small text-changing reveal on a final step (submit verification requires real network)", () => {
    const result = isClickViewSwapVerified({
      resolvedAction: { method: "click" },
      isFinalStep: true,
      submitStep: false,
      isAdvanceWithPattern: false,
      networkDelta: 0,
      bytesDelta: 789,
      textChanged: true,
    });
    expect(result).toBe(false);
  });

  it("rejects a small text-changing reveal on an advance-pattern step", () => {
    const result = isClickViewSwapVerified({
      resolvedAction: { method: "click" },
      isFinalStep: false,
      submitStep: false,
      isAdvanceWithPattern: true,
      networkDelta: 0,
      bytesDelta: 789,
      textChanged: true,
    });
    expect(result).toBe(false);
  });

  it("rejects when network activity occurred with multiple requests", () => {
    const result = isClickViewSwapVerified({
      resolvedAction: { method: "click" },
      isFinalStep: false,
      submitStep: false,
      isAdvanceWithPattern: false,
      networkDelta: 5,
      bytesDelta: 49518,
      textChanged: false,
    });
    expect(result).toBe(false);
  });

  /**
   * The reported false positive (recon-viewswap-false-positive-on-blocked-form-submit.md):
   * a "Create Account" click blocked by required-field validation shows the
   * exact CVS repro shape (network=false, url=false, dom=false meaning no
   * strong signal — only the reveal-branch DOM growth + text change) AND the
   * ng-invalid marker count grew post-click. Must NOT be credited as verified.
   */
  it("rejects a large DOM-growth reveal when invalidMarkerDelta > 0 (blocked form submit, CVS repro)", () => {
    const result = isClickViewSwapVerified({
      resolvedAction: { method: "click" },
      isFinalStep: false,
      submitStep: false,
      isAdvanceWithPattern: false,
      networkDelta: 0,
      bytesDelta: 49518,
      textChanged: true,
      invalidMarkerDelta: 2,
    });
    expect(result).toBe(false);
  });

  it("rejects a small text-changing reveal when invalidMarkerDelta > 0", () => {
    const result = isClickViewSwapVerified({
      resolvedAction: { method: "click" },
      isFinalStep: false,
      submitStep: false,
      isAdvanceWithPattern: false,
      networkDelta: 0,
      bytesDelta: 789,
      textChanged: true,
      invalidMarkerDelta: 1,
    });
    expect(result).toBe(false);
  });

  it("still credits a legitimate view-swap reveal when invalidMarkerDelta is 0", () => {
    const result = isClickViewSwapVerified({
      resolvedAction: { method: "click" },
      isFinalStep: false,
      submitStep: false,
      isAdvanceWithPattern: false,
      networkDelta: 0,
      bytesDelta: 49518,
      textChanged: false,
      invalidMarkerDelta: 0,
    });
    expect(result).toBe(true);
  });

  it("still credits a legitimate view-swap reveal when invalidMarkerDelta is omitted (default callers)", () => {
    const result = isClickViewSwapVerified({
      resolvedAction: { method: "click" },
      isFinalStep: false,
      submitStep: false,
      isAdvanceWithPattern: false,
      networkDelta: 0,
      bytesDelta: 49518,
      textChanged: false,
    });
    expect(result).toBe(true);
  });
});
