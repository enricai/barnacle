import { describe, expect, it } from "vitest";

import { isClickStateToggleVerified } from "@/scraper/flow-runner";

describe("flow-runner/isClickStateToggleVerified — client-side state-toggle gate", () => {
  /**
   * A non-advance, non-final click whose selection-state signature flipped
   * (aria-pressed/checked/selected, data-state, or a selected/active/checked
   * class) with zero network is credited — independent of byte size, which the
   * view-swap gate's floor cannot do.
   */
  it("credits a click that flipped selection state with zero network", () => {
    const result = isClickStateToggleVerified({
      resolvedAction: { method: "click" },
      isFinalStep: false,
      submitStep: false,
      isAdvance: false,
      networkDelta: 0,
      selectionStateChanged: true,
    });
    expect(result).toBe(true);
  });

  it("rejects when the selection-state signature did not change (trivial reflow / no-op)", () => {
    const result = isClickStateToggleVerified({
      resolvedAction: { method: "click" },
      isFinalStep: false,
      submitStep: false,
      isAdvance: false,
      networkDelta: 0,
      selectionStateChanged: false,
    });
    expect(result).toBe(false);
  });

  /**
   * Scope guards: a state flip on a final/submit step is NOT credited — those
   * keep their stronger submit-judge gate (a selection change is not proof of
   * a submit).
   */
  it("rejects a state flip on a final step (submit verification requires its own gate)", () => {
    const result = isClickStateToggleVerified({
      resolvedAction: { method: "click" },
      isFinalStep: true,
      submitStep: false,
      isAdvance: false,
      networkDelta: 0,
      selectionStateChanged: true,
    });
    expect(result).toBe(false);
  });

  it("rejects a state flip on a submitStep", () => {
    const result = isClickStateToggleVerified({
      resolvedAction: { method: "click" },
      isFinalStep: false,
      submitStep: true,
      isAdvance: false,
      networkDelta: 0,
      selectionStateChanged: true,
    });
    expect(result).toBe(false);
  });

  /**
   * A state flip on ANY advance/"Next" step is NOT credited — stricter than
   * isClickViewSwapVerified (which only excludes advance-WITH-pattern). A
   * validation re-render can flip a control's selection without moving the
   * wizard, and an advance without a configured transition pattern has no
   * real-transition veto, so crediting a bare selection change would desync
   * the wizard step pointer.
   */
  it("rejects a state flip on an advance step even with no transition pattern configured", () => {
    const result = isClickStateToggleVerified({
      resolvedAction: { method: "click" },
      isFinalStep: false,
      submitStep: false,
      isAdvance: true,
      networkDelta: 0,
      selectionStateChanged: true,
    });
    expect(result).toBe(false);
  });

  /**
   * If network activity occurred, the network signal is authoritative — this
   * gate only owns the pure client-side case.
   */
  it("rejects when network activity occurred (networkDelta > 0)", () => {
    const result = isClickStateToggleVerified({
      resolvedAction: { method: "click" },
      isFinalStep: false,
      submitStep: false,
      isAdvance: false,
      networkDelta: 1,
      selectionStateChanged: true,
    });
    expect(result).toBe(false);
  });

  it("rejects non-click actions even when selection state changed", () => {
    const result = isClickStateToggleVerified({
      resolvedAction: { method: "type" },
      isFinalStep: false,
      submitStep: false,
      isAdvance: false,
      networkDelta: 0,
      selectionStateChanged: true,
    });
    expect(result).toBe(false);
  });

  it("rejects when resolvedAction is null", () => {
    const result = isClickStateToggleVerified({
      resolvedAction: null,
      isFinalStep: false,
      submitStep: false,
      isAdvance: false,
      networkDelta: 0,
      selectionStateChanged: true,
    });
    expect(result).toBe(false);
  });
});
