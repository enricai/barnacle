import type { Page } from "@browserbasehq/stagehand";
import { describe, expect, it, vi } from "vitest";

import type { FrameTarget } from "@/scraper/frame-target";
import type { SubmitCandidate } from "@/scraper/submit-control";
import { captureTargetResolutionDiagnosticSnapshot } from "@/scraper/target-resolution-diagnostic";

/** Fake `Page` whose `evaluate` dispatches on the generated expression's shape, mirroring the real rank-then-detail round trip. */
function fakePage(candidates: SubmitCandidate[]): {
  page: Page;
  evaluate: ReturnType<typeof vi.fn>;
} {
  const evaluate = vi.fn().mockImplementation(async (expr: unknown) => {
    const src = String(expr);
    if (src.includes("ranked.sort")) return candidates;
    return {
      details: candidates.map(() => ({ role: "button", visible: true, disabled: false })),
      excerpt: candidates.length > 0 ? "Submit application" : null,
    };
  });
  return { page: { evaluate } as unknown as Page, evaluate };
}

describe("captureTargetResolutionDiagnosticSnapshot", () => {
  it("ranks and annotates candidates from a fresh page.evaluate round trip", async () => {
    const candidates: SubmitCandidate[] = [
      { deepIndex: 3, tier: 3, tag: "button", accessibleName: "Submit" },
    ];
    const { page } = fakePage(candidates);

    const snapshot = await captureTargetResolutionDiagnosticSnapshot(undefined, page);

    expect(snapshot).toMatchObject({
      candidates: [
        {
          tag: "button",
          accessibleName: "Submit",
          tier: 3,
          role: "button",
          visible: true,
          disabled: false,
        },
      ],
      accessibilityExcerpt: "Submit application",
    });
  });

  it("reuses a precomputed ranked list instead of re-running the rank evaluate", async () => {
    const candidates: SubmitCandidate[] = [
      { deepIndex: 5, tier: 2, tag: "input", accessibleName: "submit" },
    ];
    const { page, evaluate } = fakePage(candidates);

    const snapshot = await captureTargetResolutionDiagnosticSnapshot(undefined, page, candidates);

    const rankCalls = evaluate.mock.calls.filter(([expr]) => String(expr).includes("ranked.sort"));
    expect(rankCalls.length).toBe(0);
    expect(snapshot?.candidates).toHaveLength(1);
  });

  it("evaluates against the frame target when one is given, not the top-level page", async () => {
    const candidates: SubmitCandidate[] = [
      { deepIndex: 0, tier: 1, tag: "a", accessibleName: "submit" },
    ];
    const { page: fallbackPage } = fakePage([]);
    const { page: framePage, evaluate: frameEvaluate } = fakePage(candidates);
    const frameTarget = { evaluate: frameEvaluate } as unknown as FrameTarget;
    void framePage;

    await captureTargetResolutionDiagnosticSnapshot(frameTarget, fallbackPage);

    expect(frameEvaluate).toHaveBeenCalled();
  });

  it("returns null instead of throwing when evaluate rejects on an already-failing page", async () => {
    const page = { evaluate: vi.fn().mockRejectedValue(new Error("detached")) } as unknown as Page;

    const snapshot = await captureTargetResolutionDiagnosticSnapshot(undefined, page);

    expect(snapshot).toBeNull();
  });

  it("does not throw on an empty/minimal tree with no candidates found", async () => {
    const { page } = fakePage([]);

    const snapshot = await captureTargetResolutionDiagnosticSnapshot(undefined, page);

    expect(snapshot).toMatchObject({ candidates: [], accessibilityExcerpt: null });
  });

  it("bounds the candidate list to MAX_SNAPSHOT_CANDIDATES", async () => {
    const candidates: SubmitCandidate[] = Array.from({ length: 40 }, (_, i) => ({
      deepIndex: i,
      tier: 1,
      tag: "button",
      accessibleName: `submit ${i}`,
    }));
    const { page } = fakePage(candidates);

    const snapshot = await captureTargetResolutionDiagnosticSnapshot(undefined, page);

    expect(snapshot?.candidates.length).toBeLessThanOrEqual(25);
  });
});
