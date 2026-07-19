/**
 * Submit-control locator: ranks every submit-shaped candidate the deep
 * resolver (`deep-query.ts`) can reach — piercing open shadow roots — so
 * the cascade can act on the best-ranked candidate and retry the runner-up
 * if the first click phantoms. A false-positive submit click on a real run
 * (e.g. clicking "Save draft") is worse than the current failure, since it
 * could submit a half-filled application — so ranking is deliberately
 * conservative: only tiers with strong, unambiguous submit signal are
 * included, and "Back"/"Cancel"/"Save draft"-shaped controls never appear.
 */

/**
 * Verbs that identify a control as NOT the submit action even when it is
 * button-shaped and reachable. Checked before any positive tier so a
 * button whose text merely contains "submit" as a substring of a longer
 * negative phrase (unlikely in practice, but the exclusion is what makes
 * the ranking conservative) cannot slip through.
 */
const NEGATIVE_TEXT_EXPR = `((text) => {
  const negatives = ["back", "cancel", "save draft", "save for later", "previous", "close"];
  return negatives.some((n) => text === n || text.startsWith(n + " ") || text.endsWith(" " + n));
})`;

/**
 * Normalizes an element's accessible name to lowercase, whitespace-collapsed
 * text, preferring `aria-label` over visible `textContent` (mirrors
 * `SUBMIT_SHAPED_EL_EXPR`'s own normalization in deep-query.ts so both
 * modules treat the same DOM the same way).
 */
const ACCESSIBLE_NAME_EXPR = `((el) => {
  const norm = (s) => (s || "").replace(/\\s+/g, " ").trim().toLowerCase();
  return norm(el.getAttribute("aria-label") || el.textContent || "");
})`;

/**
 * Recursive open-shadow-root walker, identical in shape to `deep-query.ts`'s
 * private `DEEP_ELEMENTS_EXPR` (duplicated rather than imported because both
 * are browser-context expression strings composed by string interpolation,
 * not runtime code that can share a module import).
 */
const DEEP_ELEMENTS_EXPR = `((root) => {
  const out = [];
  const walk = (node) => {
    const kids = node.querySelectorAll ? Array.from(node.querySelectorAll("*")) : [];
    for (const el of kids) {
      out.push(el);
      if (el.shadowRoot) walk(el.shadowRoot);
    }
  };
  walk(root);
  return out;
})`;

/**
 * Ranking tiers, most confident first. Each tier's `test` receives the
 * element plus its precomputed accessible name and reports whether it
 * belongs in that tier — the first matching tier wins, so an element that
 * qualifies for tier 1 is never re-evaluated against tier 2/3.
 *
 * 1. Explicit `type="submit"` — unambiguous native semantics.
 * 2. Accessible name is exactly (or is dominated by) "submit" — covers the
 *    shadow-root button whose text is "Submit" but carries no type
 *    attribute (Stencil/web-component controls often omit it).
 * 3. Button/role="button" element whose accessible name contains "submit"
 *    as a distinct word alongside other text (e.g. "Submit Application"),
 *    with no negative verb present — covers Angular-style controls matched
 *    by role + text rather than by type.
 */
const RANK_TIERS_EXPR = `((el, name) => {
  const isNegative = ${NEGATIVE_TEXT_EXPR};
  if (isNegative(name)) return 0;
  const tag = (el.tagName || "").toLowerCase();
  const type = (el.getAttribute("type") || "").toLowerCase();
  const role = (el.getAttribute("role") || "").toLowerCase();
  const isButtonLike = tag === "button" || tag === "input" || role === "button";
  if (!isButtonLike) return 0;
  if ((tag === "button" || tag === "input") && type === "submit") return 3;
  if (name === "submit") return 2;
  if (/\\bsubmit\\b/.test(name)) return 1;
  return 0;
})`;

/**
 * Builds a self-contained `page.evaluate` expression string that walks the
 * whole document (light DOM plus every open shadow root, arbitrarily deep)
 * and returns every submit-shaped candidate ranked by confidence tier,
 * highest first. Ties within a tier keep document order. Elements that
 * match no positive tier — including anything caught by
 * {@link NEGATIVE_TEXT_EXPR} — are excluded entirely rather than ranked
 * last, so the caller never has to guess where the "safe" cutoff is.
 *
 * Each returned candidate carries `deepIndex`, the candidate's position in
 * this same deterministic deep-traversal order. {@link buildClickByDeepIndexExpr}
 * re-runs the identical traversal and clicks the element at that index, so
 * the caller can locate once, decide which candidate to try, then click by
 * index without holding a live element handle across the two round trips.
 */
export function buildRankSubmitCandidatesExpr(): string {
  return `(() => {
    const accessibleName = ${ACCESSIBLE_NAME_EXPR};
    const rankTier = ${RANK_TIERS_EXPR};
    const deepElements = ${DEEP_ELEMENTS_EXPR};
    const all = deepElements(document);
    const ranked = [];
    for (let i = 0; i < all.length; i++) {
      const el = all[i];
      const name = accessibleName(el);
      const tier = rankTier(el, name);
      if (tier === 0) continue;
      ranked.push({
        deepIndex: i,
        tier,
        tag: (el.tagName || "").toLowerCase(),
        accessibleName: name,
      });
    }
    ranked.sort((a, b) => b.tier - a.tier);
    return ranked;
  })()`;
}

/**
 * Builds a self-contained `page.evaluate` expression string that re-runs
 * the same deterministic deep traversal as {@link buildRankSubmitCandidatesExpr}
 * and clicks the element at `deepIndex` (dispatching focus + bubbling
 * mousedown/mouseup/click, matching `deep-query.ts`'s controlled-state click
 * convention). Returns `{ clicked: false }` without throwing if the index is
 * out of range for the current DOM (e.g. the page changed between the
 * locate and click calls).
 */
export function buildClickByDeepIndexExpr(deepIndex: number): string {
  return `(() => {
    const deepElements = ${DEEP_ELEMENTS_EXPR};
    const all = deepElements(document);
    const el = all[${JSON.stringify(deepIndex)}];
    if (!el) return { clicked: false };
    if (typeof el.focus === "function") { try { el.focus(); } catch (e) {} }
    el.dispatchEvent(new Event("mousedown", { bubbles: true }));
    el.dispatchEvent(new Event("mouseup", { bubbles: true }));
    el.dispatchEvent(new Event("click", { bubbles: true }));
    return { clicked: true };
  })()`;
}

/** Confidence tier for a ranked submit candidate — higher is more confident. See {@link buildRankSubmitCandidatesExpr}. */
export type SubmitCandidateTier = 1 | 2 | 3;

/** One ranked candidate returned by {@link buildRankSubmitCandidatesExpr}'s `page.evaluate` call. */
export interface SubmitCandidate {
  /** Position in the deterministic deep-traversal order; pass to {@link buildClickByDeepIndexExpr} to click this exact candidate. */
  deepIndex: number;
  tier: SubmitCandidateTier;
  tag: string;
  accessibleName: string;
}

/** Result of {@link buildClickByDeepIndexExpr}'s `page.evaluate` call. */
export interface ClickByDeepIndexResult {
  clicked: boolean;
}
