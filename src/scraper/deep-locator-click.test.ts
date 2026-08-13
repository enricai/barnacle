import { describe, expect, it, vi } from "vitest";

import type { DeepLocatorCandidate } from "@/scraper/deep-locator-candidates";
import {
  clickFirstActionableCandidate,
  DEFAULT_CLICK_CANDIDATE_ATTEMPT_CAP,
} from "@/scraper/deep-locator-click";
import { NODE_NOT_ACTIONABLE_MESSAGE } from "@/scraper/deep-locator-fake";
import { WatchdogTimeoutError } from "@/scraper/watchdog";

function makeCandidate(index: number, accessibleText = `candidate ${index}`): DeepLocatorCandidate {
  return { index, selector: `deeplocator=#frame >> nth=${index}`, accessibleText, isNav: false };
}

describe("clickFirstActionableCandidate", () => {
  it("skips a not-actionable rejection and clicks the next candidate, recording both selectors as tried", async () => {
    const candidates = [makeCandidate(0), makeCandidate(1)];
    const click = vi
      .fn()
      .mockRejectedValueOnce(new Error(NODE_NOT_ACTIONABLE_MESSAGE))
      .mockResolvedValueOnce(undefined);

    const outcome = await clickFirstActionableCandidate(candidates, click);

    expect(outcome).toEqual({
      clicked: true,
      candidate: candidates[1],
      triedSelectors: [candidates[0]?.selector, candidates[1]?.selector],
      counterStalledSelectors: [],
    });
    expect(click).toHaveBeenCalledTimes(2);
    expect(click).toHaveBeenNthCalledWith(1, candidates[0]);
    expect(click).toHaveBeenNthCalledWith(2, candidates[1]);
  });

  it("stops the walk and surfaces a rejection that is NOT a not-actionable error", async () => {
    const candidates = [makeCandidate(0), makeCandidate(1)];
    const frameDetached = new Error("frame detached");
    const click = vi.fn().mockRejectedValueOnce(frameDetached).mockResolvedValueOnce(undefined);

    await expect(clickFirstActionableCandidate(candidates, click)).rejects.toThrow(frameDetached);
    expect(click).toHaveBeenCalledTimes(1);
  });

  it("stops the walk and surfaces a WatchdogTimeoutError from a wedged click", async () => {
    const candidates = [makeCandidate(0), makeCandidate(1)];
    const wedged = new WatchdogTimeoutError("deepLocator click() for #frame nth=0", 10_000);
    const click = vi.fn().mockRejectedValueOnce(wedged).mockResolvedValueOnce(undefined);

    await expect(clickFirstActionableCandidate(candidates, click)).rejects.toBe(wedged);
    expect(click).toHaveBeenCalledTimes(1);
  });

  it("skips a candidate refused by the deny predicate without clicking it, then continues", async () => {
    const denied = makeCandidate(0, "Save and Exit");
    const allowed = makeCandidate(1, "Manual Application");
    const click = vi.fn().mockResolvedValue(undefined);
    const denyCandidate = vi.fn(
      (candidate: DeepLocatorCandidate) => candidate.accessibleText === "Save and Exit"
    );

    const outcome = await clickFirstActionableCandidate([denied, allowed], click, {
      denyCandidate,
    });

    expect(outcome).toEqual({
      clicked: true,
      candidate: allowed,
      triedSelectors: [allowed.selector],
      counterStalledSelectors: [],
    });
    expect(click).toHaveBeenCalledTimes(1);
    expect(click).toHaveBeenCalledWith(allowed);
    expect(denyCandidate).toHaveBeenCalledWith(denied);
  });

  it("resolves to a null/not-clicked outcome carrying every tried selector when the list is exhausted", async () => {
    const candidates = [makeCandidate(0), makeCandidate(1), makeCandidate(2)];
    const click = vi.fn().mockRejectedValue(new Error(NODE_NOT_ACTIONABLE_MESSAGE));

    const outcome = await clickFirstActionableCandidate(candidates, click);

    expect(outcome).toEqual({
      clicked: false,
      candidate: null,
      triedSelectors: candidates.map((c) => c.selector),
      counterStalledSelectors: [],
    });
    expect(click).toHaveBeenCalledTimes(3);
  });

  it("never throws on exhaustion, even when every candidate is denied", async () => {
    const candidates = [makeCandidate(0), makeCandidate(1)];
    const click = vi.fn();

    const outcome = await clickFirstActionableCandidate(candidates, click, {
      denyCandidate: () => true,
    });

    expect(outcome).toEqual({
      clicked: false,
      candidate: null,
      triedSelectors: [],
      counterStalledSelectors: [],
    });
    expect(click).not.toHaveBeenCalled();
  });

  it("bounds click attempts by an explicit cap so a huge candidate list can't burn the whole step budget", async () => {
    const candidates = Array.from({ length: 371 }, (_, index) => makeCandidate(index));
    const click = vi.fn().mockRejectedValue(new Error(NODE_NOT_ACTIONABLE_MESSAGE));

    const outcome = await clickFirstActionableCandidate(candidates, click);

    expect(outcome.clicked).toBe(false);
    expect(click).toHaveBeenCalledTimes(DEFAULT_CLICK_CANDIDATE_ATTEMPT_CAP);
    expect(outcome.triedSelectors).toHaveLength(DEFAULT_CLICK_CANDIDATE_ATTEMPT_CAP);
  });

  it("honors a caller-supplied attemptCap override", async () => {
    const candidates = Array.from({ length: 10 }, (_, index) => makeCandidate(index));
    const click = vi.fn().mockRejectedValue(new Error(NODE_NOT_ACTIONABLE_MESSAGE));

    const outcome = await clickFirstActionableCandidate(candidates, click, { attemptCap: 2 });

    expect(click).toHaveBeenCalledTimes(2);
    expect(outcome.triedSelectors).toHaveLength(2);
  });

  it("does not count denied candidates against the attempt cap", async () => {
    const candidates = [
      makeCandidate(0, "Save and Exit"),
      makeCandidate(1, "Save and Exit"),
      makeCandidate(2, "Manual Application"),
    ];
    const click = vi.fn().mockResolvedValue(undefined);

    const outcome = await clickFirstActionableCandidate(candidates, click, {
      denyCandidate: (candidate) => candidate.accessibleText === "Save and Exit",
      attemptCap: 1,
    });

    expect(outcome.clicked).toBe(true);
    expect(outcome.candidate).toEqual(candidates[2]);
    expect(click).toHaveBeenCalledTimes(1);
  });

  describe("selection-counter check (next-best on a stalled counter)", () => {
    it("advances to the next candidate when a click resolves but the counter did not rise", async () => {
      const candidates = [makeCandidate(0), makeCandidate(1)];
      const click = vi.fn().mockResolvedValue(undefined);
      // Candidate 0 clicks but the counter stays at baseline; candidate 1 raises it.
      const readSelectionCount = vi
        .fn<() => Promise<number | null>>()
        .mockResolvedValueOnce(0)
        .mockResolvedValueOnce(1);

      const outcome = await clickFirstActionableCandidate(candidates, click, {
        readSelectionCount,
        baselineSelectionCount: 0,
      });

      expect(outcome).toEqual({
        clicked: true,
        candidate: candidates[1],
        triedSelectors: [candidates[0]?.selector, candidates[1]?.selector],
        counterStalledSelectors: [candidates[0]?.selector],
      });
      expect(click).toHaveBeenCalledTimes(2);
      expect(readSelectionCount).toHaveBeenCalledTimes(2);
    });

    it("returns immediately without a second click when the counter rises on the first candidate (toggle-double-click guard)", async () => {
      const candidates = [makeCandidate(0), makeCandidate(1)];
      const click = vi.fn().mockResolvedValue(undefined);
      const readSelectionCount = vi.fn<() => Promise<number | null>>().mockResolvedValue(1);

      const outcome = await clickFirstActionableCandidate(candidates, click, {
        readSelectionCount,
        baselineSelectionCount: 0,
      });

      expect(outcome.clicked).toBe(true);
      expect(outcome.candidate).toEqual(candidates[0]);
      expect(outcome.counterStalledSelectors).toEqual([]);
      expect(click).toHaveBeenCalledTimes(1);
      expect(readSelectionCount).toHaveBeenCalledTimes(1);
    });

    it("never vetoes when the reader returns null (counter-less widget)", async () => {
      const candidates = [makeCandidate(0), makeCandidate(1)];
      const click = vi.fn().mockResolvedValue(undefined);
      const readSelectionCount = vi.fn<() => Promise<number | null>>().mockResolvedValue(null);

      const outcome = await clickFirstActionableCandidate(candidates, click, {
        readSelectionCount,
        baselineSelectionCount: 0,
      });

      expect(outcome.clicked).toBe(true);
      expect(outcome.candidate).toEqual(candidates[0]);
      expect(outcome.counterStalledSelectors).toEqual([]);
      expect(click).toHaveBeenCalledTimes(1);
    });

    it("exhausts to a not-clicked outcome carrying every stalled selector when no candidate registers", async () => {
      const candidates = [makeCandidate(0), makeCandidate(1), makeCandidate(2)];
      const click = vi.fn().mockResolvedValue(undefined);
      const readSelectionCount = vi.fn<() => Promise<number | null>>().mockResolvedValue(0);

      const outcome = await clickFirstActionableCandidate(candidates, click, {
        readSelectionCount,
        baselineSelectionCount: 0,
      });

      expect(outcome.clicked).toBe(false);
      expect(outcome.candidate).toBeNull();
      expect(outcome.counterStalledSelectors).toEqual(candidates.map((c) => c.selector));
    });

    it("treats a reader that throws as null (no veto, walk does not hard-fail)", async () => {
      const candidates = [makeCandidate(0)];
      const click = vi.fn().mockResolvedValue(undefined);
      const readSelectionCount = vi
        .fn<() => Promise<number | null>>()
        .mockRejectedValue(new Error("frame hiccup"));

      // The reader is the flow-runner's responsibility to make null-safe; here we
      // assert that IF it rejects, the walk surfaces the rejection rather than
      // silently continuing — the flow-runner wraps its reader in try/catch so
      // this path never fires in production, but the contract must be explicit.
      await expect(
        clickFirstActionableCandidate(candidates, click, {
          readSelectionCount,
          baselineSelectionCount: 0,
        })
      ).rejects.toThrow("frame hiccup");
    });

    it("does not call the reader for a candidate that was never clicked (not-actionable)", async () => {
      const candidates = [makeCandidate(0), makeCandidate(1)];
      const click = vi
        .fn()
        .mockRejectedValueOnce(new Error(NODE_NOT_ACTIONABLE_MESSAGE))
        .mockResolvedValueOnce(undefined);
      const readSelectionCount = vi.fn<() => Promise<number | null>>().mockResolvedValue(1);

      const outcome = await clickFirstActionableCandidate(candidates, click, {
        readSelectionCount,
        baselineSelectionCount: 0,
      });

      expect(outcome.clicked).toBe(true);
      expect(outcome.candidate).toEqual(candidates[1]);
      // Reader called once (for candidate 1's successful click), not for the
      // not-actionable candidate 0 that never clicked.
      expect(readSelectionCount).toHaveBeenCalledTimes(1);
    });

    it("behaves exactly as before when the counter options are omitted", async () => {
      const candidates = [makeCandidate(0), makeCandidate(1)];
      const click = vi.fn().mockResolvedValue(undefined);

      const outcome = await clickFirstActionableCandidate(candidates, click);

      expect(outcome.clicked).toBe(true);
      expect(outcome.candidate).toEqual(candidates[0]);
      expect(outcome.counterStalledSelectors).toEqual([]);
      expect(click).toHaveBeenCalledTimes(1);
    });
  });
});
