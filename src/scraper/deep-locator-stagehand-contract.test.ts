import { runInNewContext } from "node:vm";

import {
  locatorScriptBootstrap,
  locatorScriptGlobalRefs,
} from "@browserbasehq/stagehand/lib/v3/dom/build/locatorScripts.generated.js";
import { FrameSelectorResolver } from "@browserbasehq/stagehand/lib/v3/understudy/selectorResolver.js";
import { describe, expect, it } from "vitest";

import {
  buildDenseFormFixture,
  DENSE_FORM_TARGET_TEXT,
  type FakeDomRoot,
} from "@/scraper/deep-locator-fake";
import {
  buildScanFrameCandidatesExpr,
  type FrameCandidateScanResult,
  INTERACTIVE_CANDIDATE_SELECTOR,
} from "@/scraper/deep-locator-scan";

/**
 * Installed `@browserbasehq/stagehand` version every assertion below was
 * verified against (package.json floats `^3.6.0`) — re-verify this file
 * against `node_modules/@browserbasehq/stagehand/package.json`'s `version`
 * whenever the lockfile bumps it, since these contracts live in Stagehand's
 * own minified source, not in a type-checked public API.
 */
const VERIFIED_STAGEHAND_VERSION = "3.7.0";

/**
 * Executes a generated expression string against a fake `document` bound as
 * global `document` — mirrors `deep-locator-scan.dense-form.test.ts`'s own
 * harness so this file proves the Stagehand-side half of the contract
 * against the IDENTICAL fixture, not a reimplementation of it.
 */
function evaluateInFakePage(expr: string, document: FakeDomRoot): unknown {
  return runInNewContext(expr, {
    document,
    getComputedStyle: (el: { computedStyle: unknown }) => el.computedStyle,
    console,
  });
}

/**
 * Invokes the installed package's OWN `resolveCssSelector` — the same
 * generated bootstrap + global-ref invocation shape
 * `FrameSelectorResolver.buildLocatorInvocation` builds in
 * `selectorResolver.js` (`return \`(() => { ${locatorScriptBootstrap}; return ${call}; })()\``)
 * — against `root`, so this pin runs Stagehand's real primary CSS resolver
 * rather than a description of it.
 */
function resolveViaStagehand(selector: string, index: number, root: FakeDomRoot): unknown {
  const invocation = `${locatorScriptGlobalRefs.resolveCssSelector}(${JSON.stringify(selector)}, ${index})`;
  const expr = `(() => { ${locatorScriptBootstrap}; return ${invocation}; })()`;
  return evaluateInFakePage(expr, root);
}

describe(`Stagehand ${VERIFIED_STAGEHAND_VERSION} resolver contracts the batched-scan fix depends on`, () => {
  it("resolveCssSelector(sel, index) resolves the SAME element buildScanFrameCandidatesExpr reported at that index, for every surviving candidate after visibility filtering — verified against the installed Stagehand 3.7.0", () => {
    const { root } = buildDenseFormFixture();
    const expectedMatches = root.querySelectorAll(INTERACTIVE_CANDIDATE_SELECTOR);

    const scanResults = evaluateInFakePage(
      buildScanFrameCandidatesExpr(INTERACTIVE_CANDIDATE_SELECTOR),
      root
    ) as FrameCandidateScanResult[];
    const visibleCandidates = scanResults.filter((candidate) => candidate.visible);
    const droppedIndices = scanResults
      .filter((candidate) => !candidate.visible)
      .map((candidate) => candidate.index);

    // The fixture's two unrendered decoys sit before the visible target button
    // in document order, so this run exercises a real index gap (not just a
    // contiguous 0..n-1 range) — the exact "visibility filtering drops
    // earlier indices" case the contract must hold under.
    expect(droppedIndices.length).toBeGreaterThan(0);
    expect(Math.max(...droppedIndices)).toBeLessThan(
      Math.max(...visibleCandidates.map((candidate) => candidate.index))
    );

    for (const candidate of visibleCandidates) {
      const expected = expectedMatches[candidate.index];
      expect(expected).toBeDefined();
      // Stagehand 3.7.0's resolveCssSelector(sel, i) = querySelectorAll(sel)[i]
      // in the frame's own document (selectorResolver.js's `Y`/`Ct` helpers) —
      // the same resolution deepLocator(hop).nth(index) ultimately reaches.
      const resolved = resolveViaStagehand(INTERACTIVE_CANDIDATE_SELECTOR, candidate.index, root);
      expect(resolved).toBe(expected);
    }
  });

  it("resolves the icon-only target button's scan-reported index to the target element itself, not merely to `a`-matching-object of the same shape — Stagehand 3.7.0", () => {
    const { root } = buildDenseFormFixture();
    const scanResults = evaluateInFakePage(
      buildScanFrameCandidatesExpr(INTERACTIVE_CANDIDATE_SELECTOR),
      root
    ) as FrameCandidateScanResult[];
    const targetCandidate = scanResults.find(
      (candidate) => candidate.text === DENSE_FORM_TARGET_TEXT
    );
    expect(targetCandidate).toBeDefined();
    if (!targetCandidate) throw new Error("unreachable: asserted defined above");

    // Stagehand 3.7.0: resolveCssSelector returns the live element, so its
    // own aria-label still reads back through the resolved reference.
    const resolved = resolveViaStagehand(
      INTERACTIVE_CANDIDATE_SELECTOR,
      targetCandidate.index,
      root
    ) as { getAttribute(name: string): string | null };
    expect(resolved.getAttribute("aria-label")).toBe(DENSE_FORM_TARGET_TEXT);
  });

  it("FrameSelectorResolver.parseSelector keeps a comma-bearing selector as one css query verbatim when it carries no '>>' hop — Stagehand 3.7.0", () => {
    const parsed = FrameSelectorResolver.parseSelector(INTERACTIVE_CANDIDATE_SELECTOR);
    expect(parsed).toEqual({ kind: "css", value: INTERACTIVE_CANDIDATE_SELECTOR });
  });

  it("FrameSelectorResolver.parseSelector rewrites a '>>'-bearing selector by space-joining its hops, losing frame-scoping — pinning why INTERACTIVE_CANDIDATE_SELECTOR must stay the FINAL hop segment (verified against Stagehand 3.7.0)", () => {
    const hopNotation = `iframe#id >> ${INTERACTIVE_CANDIDATE_SELECTOR}`;
    const parsed = FrameSelectorResolver.parseSelector(hopNotation);
    expect(parsed).toEqual({
      kind: "css",
      value: `iframe#id ${INTERACTIVE_CANDIDATE_SELECTOR}`,
    });
    expect(parsed.value).not.toBe(hopNotation);
  });
});
