/**
 * Target-resolution failure diagnostic: when every technique the cascade has
 * (Stagehand act/observe, the deep-locator resolver, the child-iframe
 * fallback) fails to find a step's target, the next person debugging that
 * failure has nothing to go on but a body-HTML dump and a guess. This module
 * captures WHAT the submit-shaped ranking itself saw at the moment of
 * failure — every candidate it ranked, with enough identity (tag, role,
 * accessible name, tier, visibility, disabled state) to tell "the target
 * genuinely wasn't there" apart from "it was there but ranked wrong" or "it
 * was there but disabled/hidden" — so a live failure is diagnosable without
 * another guessing round.
 */

import type { Page } from "@browserbasehq/stagehand";

import { getLogger } from "@/lib/logging";
import { buildRankSubmitCandidatesExpr, type SubmitCandidateTier } from "@/scraper/submit-control";
import type { FrameTarget } from "@/scraper/frame-target";

const logger = getLogger({ name: "scraper/target-resolution-diagnostic" });

/** Cap on the number of ranked candidates kept in a snapshot. */
const MAX_SNAPSHOT_CANDIDATES = 25;

/**
 * Byte budget for the whole serialized snapshot. Mirrors flow-runner.ts's
 * `FAILURE_DUMP_MAX_BODY_LENGTH` truncation convention for `bodyOuterHtml`
 * (100KB) but scaled down: this snapshot is a small structured summary, not
 * a raw DOM dump, so a much smaller cap already comfortably bounds a
 * pathological page (thousands of candidates or a huge excerpt) without
 * ever approaching the body-dump's own budget.
 */
const MAX_SNAPSHOT_JSON_LENGTH = 20_000;

/** Cap on the accessibility-tree excerpt before it is folded into the snapshot. */
const MAX_EXCERPT_LENGTH = 2_000;

/** One submit-shaped candidate the ranking cascade saw, annotated with the fields a triager needs to tell it apart from the others. */
export interface DiagnosticSnapshotCandidate {
  tag: string;
  role: string;
  accessibleName: string;
  tier: SubmitCandidateTier;
  visible: boolean;
  disabled: boolean;
}

/** Bounded diagnostic snapshot captured at the moment target resolution gave up. */
export interface TargetResolutionDiagnosticSnapshot {
  /** Every submit-shaped candidate the ranking cascade saw, highest tier first — the top entry is what the cascade would have clicked, the rest are what it passed over. */
  candidates: DiagnosticSnapshotCandidate[];
  /** Short accessibility-tree excerpt of the region the failed step's instruction most plausibly targeted, or `null` when no candidate was found to anchor the excerpt on. */
  accessibilityExcerpt: string | null;
}

/**
 * Re-walks the light DOM plus every open shadow root (same traversal shape
 * as `submit-control.ts`'s private `DEEP_ELEMENTS_EXPR` — duplicated rather
 * than imported, since both are browser-context expression strings composed
 * by string interpolation, matching that module's own stated convention for
 * why `IS_VISIBLE_EXPR`/`DEEP_ELEMENTS_EXPR` are duplicated instead of
 * shared) to read the role/visible/disabled/excerpt fields the ranking
 * expression itself doesn't return, and to build a short accessible-name
 * excerpt around the top-ranked candidate. Runs as a single `page.evaluate`
 * round trip so the DOM observed here always matches the one
 * `buildRankSubmitCandidatesExpr` just ranked.
 */
function buildCandidateDetailExpr(root: string, deepIndices: readonly number[]): string {
  return `(() => {
    const deepElements = ((rootEl) => {
      const out = [];
      const walk = (node) => {
        const kids = node.querySelectorAll ? Array.from(node.querySelectorAll("*")) : [];
        for (const el of kids) {
          out.push(el);
          if (el.shadowRoot) walk(el.shadowRoot);
        }
      };
      walk(rootEl);
      return out;
    })(${root});
    const isVisible = (el) => {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) return false;
      const style = getComputedStyle(el);
      return style.display !== "none" && style.visibility !== "hidden";
    };
    const isDisabled = (el) => {
      for (let depth = 0, node = el; depth < 8 && node; depth++) {
        if (node.disabled === true) return true;
        if (node.getAttribute && node.getAttribute("aria-disabled") === "true") return true;
        node = node.parentElement;
      }
      return false;
    };
    const roleOf = (el) => {
      const explicit = el.getAttribute("role");
      if (explicit) return explicit;
      const tag = (el.tagName || "").toLowerCase();
      if (tag === "button") return "button";
      if (tag === "input") return "input";
      if (tag === "a") return "link";
      return "";
    };
    const indices = ${JSON.stringify(deepIndices)};
    const details = indices.map((i) => {
      const el = deepElements[i];
      if (!el) return { role: "", visible: false, disabled: true };
      return { role: roleOf(el), visible: isVisible(el), disabled: isDisabled(el) };
    });
    const topEl = indices.length > 0 ? deepElements[indices[0]] : null;
    let excerpt = null;
    if (topEl) {
      const container =
        topEl.closest("form, section, [role=dialog], fieldset") || topEl.parentElement || topEl;
      excerpt = (container.innerText || container.textContent || "")
        .replace(/\\s+/g, " ")
        .trim()
        .slice(0, ${MAX_EXCERPT_LENGTH});
    }
    return { details, excerpt };
  })()`;
}

/**
 * Captures a bounded diagnostic snapshot of the current submit-shaped
 * candidate ranking, called from the two `onStepFailure` sites once every
 * resolution technique has already failed. Reuses
 * {@link buildRankSubmitCandidatesExpr} for the ranking half rather than
 * re-implementing candidate scoring, so the snapshot stays honest about
 * exactly what the cascade's own ranking saw — a divergent, re-implemented
 * ranking here would risk telling a triager the cascade saw a candidate it
 * never actually considered. Never throws: an `evaluate` failure on an
 * already-failing page (navigated away, torn down) degrades to `null`,
 * mirroring the existing `bodyOuterHtml.catch(() => null)` convention at
 * both call sites, since this is diagnostic-only code and must never be
 * the reason a failure path itself fails.
 */
export async function captureTargetResolutionDiagnosticSnapshot(
  target: FrameTarget | undefined,
  page: Page
): Promise<TargetResolutionDiagnosticSnapshot | null> {
  try {
    const evaluator = target ?? page;
    const root = "document";
    const ranked = await evaluator.evaluate<
      { deepIndex: number; tier: SubmitCandidateTier; tag: string; accessibleName: string }[]
    >(buildRankSubmitCandidatesExpr(root));
    const bounded = ranked.slice(0, MAX_SNAPSHOT_CANDIDATES);
    const detail = await evaluator.evaluate<{
      details: { role: string; visible: boolean; disabled: boolean }[];
      excerpt: string | null;
    }>(buildCandidateDetailExpr(root, bounded.map((c) => c.deepIndex)));
    const candidates: DiagnosticSnapshotCandidate[] = bounded.map((c, i) => ({
      tag: c.tag,
      accessibleName: c.accessibleName,
      tier: c.tier,
      role: detail.details[i]?.role ?? "",
      visible: detail.details[i]?.visible ?? false,
      disabled: detail.details[i]?.disabled ?? true,
    }));
    const snapshot: TargetResolutionDiagnosticSnapshot = {
      candidates,
      accessibilityExcerpt: detail.excerpt || null,
    };
    const serialized = JSON.stringify(snapshot);
    if (serialized.length <= MAX_SNAPSHOT_JSON_LENGTH) return snapshot;
    return {
      candidates: candidates.slice(0, Math.max(1, Math.floor(candidates.length / 2))),
      accessibilityExcerpt: snapshot.accessibilityExcerpt,
    };
  } catch (error) {
    logger.warn(`target-resolution diagnostic snapshot failed to capture: ${String(error)}`);
    return null;
  }
}
