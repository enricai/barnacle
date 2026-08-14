import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

/**
 * Guard the byte-identity invariant the ancestor-scoped selection read-back
 * depends on: `SELECTION_STATE_MAP_EXPR` (the pre-action baseline), the
 * single-element `elementSelectionFingerprintExpr`, and `selectionAncestorChanged`
 * (the ancestor walk) must all compute the SAME positional xpath and the SAME
 * fingerprint object. If one drifts, the ancestor walk recomputes keys that miss
 * the baseline (silently no-op) or diffs mismatched fingerprint shapes. Rather
 * than duplicate the sources, the file shares `XPATH_OF_FN_SRC` and
 * `selectionFingerprintObjSrc(...)`; this test fails loudly if a future edit
 * inlines a copy again instead of interpolating the shared constant.
 */
const SOURCE = readFileSync(`${__dirname}/flow-runner.ts`, "utf8");

// Interpolation needles the exprs must contain. Built by concatenation so the
// literal `${...}` never appears as a plain-string placeholder (Biome's
// noTemplateCurlyInString would flag it) — the exprs interpolate these constants.
const XPATH_NEEDLE = `$\{XPATH_OF_FN_SRC}`;
const FP_NEEDLE = `$\{selectionFingerprintObjSrc("el", "ds")}`;

/** Extract the body of a `const NAME = \`...\`;` template-literal declaration. */
function templateBody(name: string): string {
  const start = SOURCE.indexOf(`const ${name} = \``);
  expect(start, `declaration for ${name} not found`).toBeGreaterThan(-1);
  const from = start + `const ${name} = \``.length;
  const end = SOURCE.indexOf("`;", from);
  expect(end, `closing backtick for ${name} not found`).toBeGreaterThan(-1);
  return SOURCE.slice(from, end);
}

describe("flow-runner/selection fingerprint — shared in-page source", () => {
  it("SELECTION_STATE_MAP_EXPR interpolates the shared xpath + fingerprint sources", () => {
    const body = templateBody("SELECTION_STATE_MAP_EXPR");
    expect(body).toContain(XPATH_NEEDLE);
    expect(body).toContain(FP_NEEDLE);
  });

  it("elementSelectionFingerprintExpr interpolates the shared fingerprint source", () => {
    // Function body, not a const template — match the return expression.
    expect(SOURCE).toContain(
      `const ds = el.getAttribute("data-state") || ""; return ${FP_NEEDLE}; })()`
    );
  });

  it("selectionAncestorChanged interpolates both shared sources", () => {
    const fnStart = SOURCE.indexOf("async function selectionAncestorChanged(");
    expect(fnStart, "selectionAncestorChanged not found").toBeGreaterThan(-1);
    const fnBody = SOURCE.slice(fnStart, SOURCE.indexOf("\n}\n", fnStart));
    expect(fnBody).toContain(`const xpathOf = ${XPATH_NEEDLE};`);
    expect(fnBody).toContain(FP_NEEDLE);
  });

  it("no inlined xpathOf copy survives inside the two selection exprs (must use the shared constant)", () => {
    // The literal walk `"/html[1]/body[1]/" + parts.join("/")` should appear ONLY
    // inside XPATH_OF_FN_SRC itself — not re-inlined in the selection exprs.
    const occurrences = SOURCE.split('"/html[1]/body[1]/" + parts.join("/")').length - 1;
    // One legitimate occurrence in XPATH_OF_FN_SRC, plus the two OTHER unrelated
    // in-page copies (ng-invalid probe, field-label scan) intentionally left as
    // separate expressions. If a NEW selection-expr copy is inlined, this count
    // rises above the known baseline of 3.
    expect(occurrences).toBeLessThanOrEqual(3);
  });

  it("every leaf-scoped selection read-back falls back to the ancestor walk", () => {
    // There are exactly two element-scoped selection read-backs: the primary one
    // in `verifyDomEffect`'s click branch and the `retrySelectionStateChanged`
    // n+16 native-click fallback. Both must consult `selectionAncestorChanged`
    // on a leaf miss — a design-system option that wraps its label commits its
    // selection on an ancestor, so a leaf-only read-back mis-scores the click.
    // Guard both so neither can silently regress to leaf-only (which would
    // reintroduce the phantom-click-on-selection bug at that site).
    const readbackSites =
      SOURCE.split("selectionFingerprintChanged(preFingerprint, postFingerprint)").length - 1;
    const ancestorFallbacks = SOURCE.split("selectionAncestorChanged(").length - 1;
    // Two read-back sites; `selectionAncestorChanged` appears once at its
    // definition plus once per read-back fallback = 3 references total.
    expect(readbackSites).toBe(2);
    expect(ancestorFallbacks).toBe(3);
  });
});
