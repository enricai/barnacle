import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Element as HappyDomElement } from "happy-dom";
import { Window } from "happy-dom";
import { describe, expect, it } from "vitest";
import { SUBMIT_SHAPE_EXPR } from "@/scraper/submit-control";

/**
 * Guards against the audit's chokepoint finding: the bare-in-form-button
 * submit-shape idiom used to be hand-duplicated at two independent sites in
 * flow-runner.ts — `resolvedClickTargetIsSubmitShaped`'s own tag/type check
 * (the primary-xpath-hit branch) and `XPATH_TAIL_RETARGET_RESOLVE_FN_SRC`'s
 * separately-written inline `isSubmitShaped` (the xpathTail-retarget
 * branch). Both now delegate to submit-control.ts's single exported
 * {@link SUBMIT_SHAPE_EXPR}. This test asserts (a) both sites' source still
 * routes through that one shared export rather than a re-diverged inline
 * copy, and (b) the shared predicate itself classifies a fixture matrix
 * consistently — so a future fix applied at only one site (reintroducing a
 * hand-rolled second copy) fails immediately instead of silently
 * regressing the chokepoint. A generic, site-agnostic fixture domain is
 * used throughout.
 */

const FLOW_RUNNER_SRC = readFileSync(join(__dirname, "flow-runner.ts"), "utf8");

function extractBetween(src: string, startMarker: string, endMarker: string): string {
  const start = src.indexOf(startMarker);
  if (start === -1) throw new Error(`marker not found in flow-runner.ts: ${startMarker}`);
  const end = src.indexOf(endMarker, start + startMarker.length);
  if (end === -1) throw new Error(`end marker not found in flow-runner.ts: ${endMarker}`);
  return src.slice(start, end);
}

function evalSubmitShape(el: HappyDomElement): boolean {
  const window = new Window();
  const fn = new window.Function("return (" + SUBMIT_SHAPE_EXPR + ")") as () => (
    el: unknown
  ) => boolean;
  return fn()(el as unknown);
}

type Fixture = {
  name: string;
  html: string;
  expected: boolean;
};

const FIXTURES: Fixture[] = [
  {
    name: "bare untyped in-form button, generic-verb name",
    html: '<form><button id="target">Continue</button></form>',
    expected: true,
  },
  {
    name: "bare untyped in-form button, plain non-verb name",
    html: '<form><button id="target">Widget Details</button></form>',
    expected: false,
  },
  {
    name: "native input type=submit",
    // No `value` attribute: an <input>'s accessible name is sourced from
    // `value` (see ACCESSIBLE_NAME_EXPR), so an unlabeled input carries an
    // empty name and earns credit via the sole-candidate tier, same as
    // "native input type=image" below.
    html: '<form><input id="target" type="submit" /></form>',
    expected: true,
  },
  {
    name: "native input type=image",
    html: '<form><input id="target" type="image" src="go.png" /></form>',
    expected: true,
  },
  {
    name: "negative-text in-form button",
    html: '<form><button id="target">Cancel</button></form>',
    expected: false,
  },
  {
    name: "non-form generic-action div",
    // SUBMIT_SHAPE_FALLBACK_EXPR's generic-action-verb tier is tag/role/
    // form-agnostic — it qualifies on wording alone, so a "Continue"-worded
    // div qualifies even outside any form; the no-text sole-candidate tier
    // is the one gated on form containment.
    html: '<div><div id="target">Continue</div></div>',
    expected: true,
  },
  {
    name: "non-form, no-text generic-action div (form-gated fallback tier)",
    html: '<div><div id="target"></div></div>',
    expected: false,
  },
  {
    name: "named non-generic-verb explicit type=submit, multi-candidate form",
    // "Pay now" has a text signal but matches neither NEGATIVE_TEXT_EXPR nor
    // SUBMIT_SHAPE_FALLBACK_EXPR's generic-action-verb wording, so it must
    // fall through to the sole-candidate tier -- which is gated on carrying
    // NO text at all. A named element never reaches that tier, so an
    // explicit type="submit" earns no unconditional credit here regardless
    // of sibling candidates.
    html: '<form><button id="target" type="submit">Pay now</button><button>Edit cart</button></form>',
    expected: false,
  },
  {
    name: "named non-generic-verb explicit type=submit, sole candidate in form",
    // Same accessible name as the row above, now the only actionable
    // control in its form. Still false: SUBMIT_SHAPE_FALLBACK_EXPR's
    // sole-candidate tier only rescues candidates with an EMPTY accessible
    // name (see submit-control.ts's `if (name !== "") return false;` guard,
    // which runs before the sole-candidacy check). Proves the narrowing
    // does not grant explicit type="submit" a divergent, candidacy-count-based
    // exemption from that guard.
    html: '<form><button id="target" type="submit">Pay now</button></form>',
    expected: false,
  },
  {
    name: "generic-verb explicit type=submit, sole candidate in form",
    // "Continue" matches SUBMIT_SHAPE_FALLBACK_EXPR's generic-action-verb
    // tier -- the same tier that already grants the "bare untyped in-form
    // button, generic-verb name" row above its true. Explicit type="submit"
    // reaching true via this identical wording-based tier (not via
    // unconditional type-attribute credit) proves it now shares the exact
    // corroboration path as a default-type button rather than a divergent
    // rule.
    html: '<form><button id="target" type="submit">Continue</button></form>',
    expected: true,
  },
];

describe("submit-shape decision sites: source-level parity", () => {
  it("resolvedClickTargetIsSubmitShaped's primary-xpath-hit branch delegates to the shared SUBMIT_SHAPE_EXPR export, not a hand-rolled copy", () => {
    const fnBody = extractBetween(
      FLOW_RUNNER_SRC,
      "async function resolvedClickTargetIsSubmitShaped(",
      "\n}\n"
    );
    expect(fnBody).toContain("const isSubmitShaped = ${SUBMIT_SHAPE_EXPR};");
  });

  it("XPATH_TAIL_RETARGET_RESOLVE_FN_SRC's tail-retarget disambiguation delegates to the shared SUBMIT_SHAPE_EXPR export, not a hand-rolled copy", () => {
    const constBody = extractBetween(
      FLOW_RUNNER_SRC,
      "const XPATH_TAIL_RETARGET_RESOLVE_FN_SRC = `",
      "  })`;"
    );
    expect(constBody).toContain("const isSubmitShaped = ${SUBMIT_SHAPE_EXPR};");
  });
});

describe("submit-shape decision sites: behavioral parity across a fixture matrix", () => {
  // Both decision sites are proven above (via source extraction) to reduce
  // to the literal, identical `const isSubmitShaped = ${SUBMIT_SHAPE_EXPR};`
  // runtime string — resolvedClickTargetIsSubmitShaped's primary-xpath-hit
  // branch calls `isSubmitShaped(el)` on the resolved element, and
  // XPATH_TAIL_RETARGET_RESOLVE_FN_SRC's disambiguation applies the same
  // call to each snapshot candidate. Evaluating that one shared runtime
  // string directly — not a reimplementation of either site's logic — and
  // asserting it agrees with the expected classification proves both sites
  // agree with each other by construction: if either site's source
  // ever diverged from this exact string (caught by the tests above), this
  // matrix would stop reflecting what that site actually does.
  it.each(FIXTURES)(
    "classifies '$name' as expected by the one shared predicate",
    ({ html, expected }) => {
      const window = new Window();
      const document = window.document;
      document.body.innerHTML = html;
      const target = document.getElementById("target") as unknown as HappyDomElement;
      if (!target) throw new Error("fixture setup failed: #target not found");

      expect(evalSubmitShape(target)).toBe(expected);
    }
  );
});
