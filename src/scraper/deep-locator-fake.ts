import type { DeepLocatorDelegate } from "@browserbasehq/stagehand/lib/v3/understudy/deepLocator.js";

/**
 * Shared, in-memory model of a `page.deepLocator()`-reachable hop: the
 * downstream fixtures register one entry per hop selector they need
 * `count()`/`click()` to resolve, and read `clicks`/`filledWith` back to
 * assert the fix actually routed through `deepLocator` rather than
 * `observe`/`act`.
 */
export interface FakeDeepLocatorHop {
  clicks: number;
  filledWith: string | null;
  text: string;
}

/**
 * Registry the fake `deepLocator()` resolves against, keyed by the exact
 * hop selector string (`buildHopSelector`'s `"iframe#id >> inner"` shape) —
 * mirrors how the real `DeepLocatorDelegate` re-resolves the DOM node fresh
 * on every call rather than caching a handle.
 */
export type FakeDeepLocatorFrame = Map<string, FakeDeepLocatorHop>;

/**
 * Registers a hop selector so a subsequent `deepLocator(selector).count()`
 * resolves to 1. `text` seeds `textContent()` — `resolveDeepLocatorCandidates`
 * reads it to build a candidate's `accessibleText`.
 */
export function registerDeepLocatorHop(
  frame: FakeDeepLocatorFrame,
  selector: string,
  text = ""
): FakeDeepLocatorHop {
  const hop: FakeDeepLocatorHop = { clicks: 0, filledWith: null, text };
  frame.set(selector, hop);
  return hop;
}

/**
 * Only the methods `src/scraper/flow-runner.ts`'s deepLocator-routed call
 * sites (`observe-act`, rephrase evidence, the pre-cascade probe) actually
 * invoke, via `deep-locator-candidates.ts`: `count()` to check candidate
 * existence, `click()`/`fill()` to act, `textContent()` to read
 * `accessibleText`, `first()`/`nth()` for the same chaining
 * `buildHopSelector`-composed multi-match selectors need. `hover`/`type`/
 * `selectOption`/`isVisible`/`isChecked`/`inputValue`/`innerHtml`/
 * `innerText`/`setInputFiles`/`scrollTo`/`centroid`/`backendNodeId`/
 * `highlight`/`sendClickEvent` are declared on the real `DeepLocatorDelegate`
 * but no planned call site routes through them, so they are omitted here —
 * adding one only when a call site actually needs it keeps this fake from
 * drifting out of sync with what's exercised.
 *
 * `first`/`nth` return `FakeDeepLocatorDelegate` (not the real
 * `DeepLocatorDelegate` class a `Pick` would demand) since a fake has no
 * private `page`/`root`/`nthIndex` fields to construct one with — the
 * self-check test proves each modeled method's signature still matches the
 * real delegate's public contract.
 */
export interface FakeDeepLocatorDelegate {
  click: DeepLocatorDelegate["click"];
  count: DeepLocatorDelegate["count"];
  fill: DeepLocatorDelegate["fill"];
  textContent: DeepLocatorDelegate["textContent"];
  first(): FakeDeepLocatorDelegate;
  nth(index: number): FakeDeepLocatorDelegate;
}

/**
 * Builds a `deepLocator()`-shaped delegate resolving against `frame`. Each
 * call re-reads `frame.get(selector)` (never caches), matching the real
 * delegate's re-resolve-on-every-call contract — a hop that attaches after
 * construction (the mid-flow-iframe scenario) still resolves once
 * registered.
 */
function buildFakeDelegate(frame: FakeDeepLocatorFrame, selector: string): FakeDeepLocatorDelegate {
  return {
    count: async () => (frame.has(selector) ? 1 : 0),
    click: async () => {
      const hop = frame.get(selector);
      if (!hop) throw new Error(`deepLocator: no element matches "${selector}"`);
      hop.clicks += 1;
    },
    fill: async (value: string) => {
      const hop = frame.get(selector);
      if (!hop) throw new Error(`deepLocator: no element matches "${selector}"`);
      hop.filledWith = value;
    },
    textContent: async () => {
      const hop = frame.get(selector);
      if (!hop) throw new Error(`deepLocator: no element matches "${selector}"`);
      return hop.text;
    },
    first: () => buildFakeDelegate(frame, selector),
    nth: () => buildFakeDelegate(frame, selector),
  };
}

/**
 * Fake `page.deepLocator` bound to an in-memory hop registry — pass the same
 * `FakeDeepLocatorFrame` into a fake `Page`'s `deepLocator` field so a fix
 * routed through `page.deepLocator(buildHopSelector(...))` resolves against
 * fixture state instead of a browser.
 */
export function makeFakeDeepLocator(
  frame: FakeDeepLocatorFrame
): (selector: string) => FakeDeepLocatorDelegate {
  return (selector: string) => buildFakeDelegate(frame, selector);
}
