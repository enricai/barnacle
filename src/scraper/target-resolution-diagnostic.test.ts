import { runInNewContext } from "node:vm";

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

/**
 * Minimal fake DOM element supporting exactly the surface
 * `buildRankSubmitCandidatesExpr`/`buildCandidateDetailExpr` touch
 * (`tagName`, `getAttribute`, `textContent`, `querySelectorAll`,
 * `shadowRoot`, `getBoundingClientRect`, `closest`, `parentElement`),
 * mirroring `submit-control.test.ts`'s fixture so both modules exercise the
 * real generated expression strings rather than a re-implementation.
 */
interface FakeEl {
  tagName: string;
  attrs: Record<string, string>;
  textContent: string;
  children: FakeEl[];
  shadowRoot: FakeRoot | null;
  rect: { width: number; height: number };
  computedStyle: { display: string; visibility: string };
  disabled: boolean;
  parentElement: FakeEl | null;
  getAttribute(name: string): string | null;
  querySelectorAll(selector: "*"): FakeEl[];
  getBoundingClientRect(): { width: number; height: number };
  closest(selector: string): FakeEl | null;
}

interface FakeRoot {
  querySelectorAll(selector: "*"): FakeEl[];
}

function makeFakeEl(tagName: string, attrs: Record<string, string> = {}, textContent = ""): FakeEl {
  const el: FakeEl = {
    tagName: tagName.toUpperCase(),
    attrs,
    textContent,
    children: [],
    shadowRoot: null,
    rect: { width: 100, height: 20 },
    computedStyle: { display: "block", visibility: "visible" },
    disabled: false,
    parentElement: null,
    getAttribute(name) {
      return Object.hasOwn(attrs, name) ? (attrs[name] ?? null) : null;
    },
    querySelectorAll() {
      return flattenFakeDescendants(el.children);
    },
    getBoundingClientRect() {
      return el.rect;
    },
    closest() {
      return null;
    },
  };
  return el;
}

function flattenFakeDescendants(children: FakeEl[]): FakeEl[] {
  const out: FakeEl[] = [];
  for (const child of children) {
    out.push(child);
    out.push(...flattenFakeDescendants(child.children));
  }
  return out;
}

function makeFakeRoot(topLevel: FakeEl[]): FakeRoot {
  return {
    querySelectorAll() {
      return flattenFakeDescendants(topLevel);
    },
  };
}

/**
 * `page.evaluate` fake that actually runs the generated expression string
 * against `document` via `node:vm`, instead of stubbing a canned response —
 * proving the snapshot reflects what `buildRankSubmitCandidatesExpr` and
 * `buildCandidateDetailExpr` genuinely compute for a given DOM, not a
 * hand-authored assertion of what they should compute.
 */
function fakePageEvaluatingRealExpr(document: FakeRoot): Page {
  const evaluate = vi.fn().mockImplementation(async (expr: unknown) =>
    runInNewContext(String(expr), {
      document,
      getComputedStyle: (el: FakeEl) => el.computedStyle,
      console,
    })
  );
  return { evaluate } as unknown as Page;
}

describe("captureTargetResolutionDiagnosticSnapshot against a real generated expression", () => {
  it("surfaces a widened-tier, tag/role-agnostic generic-action candidate that pre-widening ranking would have missed", async () => {
    const genericAction = makeFakeEl("div", {}, "Create Account");
    const document = makeFakeRoot([genericAction]);
    const page = fakePageEvaluatingRealExpr(document);

    const snapshot = await captureTargetResolutionDiagnosticSnapshot(undefined, page);

    expect(snapshot?.candidates).toHaveLength(1);
    expect(snapshot?.candidates[0]).toMatchObject({
      tag: "div",
      accessibleName: "create account",
      tier: 0.5,
    });
  });

  // Rules out this module's own duplicated DEEP_ELEMENTS_EXPR (see the
  // docblock on buildCandidateDetailExpr) for a closed shadow root
  // specifically -- a separate code path from submit-control.ts's copy,
  // which already has this rule-out at ~line 671 of submit-control.test.ts.
  // `attachShadow({ mode: "closed" })` never exposes `.shadowRoot` on the
  // host element, so no page-script traversal, this module's included, can
  // walk into it; a fully-exhausted cascade legitimately produces a non-null
  // snapshot with an empty candidate list here, not an error and not a bug
  // to "fix" by trying to pierce the closed root.
  it("captures a non-null, empty-candidate snapshot when the only submit control sits behind a closed shadow root", async () => {
    // The submit button lives inside a `mode: "closed"` shadow root, which
    // by design never appears on `host.shadowRoot` -- there is no fixture
    // field to attach it to, which is the point: page-script cannot see it.
    const host = makeFakeEl("app-checkout-actions");
    const document = makeFakeRoot([host]);
    const page = fakePageEvaluatingRealExpr(document);

    const snapshot = await captureTargetResolutionDiagnosticSnapshot(undefined, page);

    expect(snapshot).not.toBeNull();
    expect(snapshot?.candidates).toEqual([]);
  });
});
