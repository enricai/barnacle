import type { DeepLocatorDelegate } from "@browserbasehq/stagehand/lib/v3/understudy/deepLocator.js";

/**
 * One candidate element registered at a hop selector. `registerDeepLocatorHop`
 * seeds a single-element hop by constructing one of these; multi-candidate
 * hops (`registerDeepLocatorHopElements`) hold an ordered array of them so
 * `nth(i)` can resolve to a distinct element's own click/fill/text state
 * instead of collapsing every index onto shared scalars.
 */
export interface FakeDeepLocatorElement {
  clicks: number;
  filledWith: string | null;
  text: string;
}

/**
 * Shared, in-memory model of a `page.deepLocator()`-reachable hop: the
 * downstream fixtures register one entry per hop selector they need
 * `count()`/`click()` to resolve, and read `clicks`/`filledWith` back to
 * assert the fix actually routed through `deepLocator` rather than
 * `observe`/`act`. `clicks`/`filledWith`/`text` mirror element 0 (getters
 * delegating to `elements[0]`) so every existing single-element consumer —
 * which only ever registers and clicks index 0 — keeps reading/observing the
 * same fields it always has.
 */
export interface FakeDeepLocatorHop {
  readonly elements: FakeDeepLocatorElement[];
  readonly clicks: number;
  readonly filledWith: string | null;
  readonly text: string;
}

function buildHop(elements: FakeDeepLocatorElement[]): FakeDeepLocatorHop {
  const first = elements[0];
  if (!first) throw new Error("deep-locator-fake: a hop needs at least one element");
  return {
    elements,
    get clicks() {
      return first.clicks;
    },
    get filledWith() {
      return first.filledWith;
    },
    get text() {
      return first.text;
    },
  };
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
  return registerDeepLocatorHopElements(frame, selector, [text]);
}

/**
 * Registers a hop selector with N ordered candidate elements so
 * `deepLocator(selector).count()` resolves to `texts.length` and
 * `nth(i).textContent()`/`nth(i).click()`/`nth(i).fill()` act on element `i`
 * specifically — the shape a real cross-origin OOPIF hop resolves to when
 * more than one element matches the inner selector (e.g. `"*"` matching
 * every node in the iframe), which the single-element
 * {@link registerDeepLocatorHop} path can't model.
 */
export function registerDeepLocatorHopElements(
  frame: FakeDeepLocatorFrame,
  selector: string,
  texts: string[]
): FakeDeepLocatorHop {
  const elements = texts.map((text) => ({ clicks: 0, filledWith: null, text }));
  const hop = buildHop(elements);
  frame.set(selector, hop);
  return hop;
}

/**
 * The `FakeDeepLocatorDelegate` methods `registerDeepLocatorHangingHop` can
 * pin open, modeling a wedged OOPIF CDP call (the run-6 78-minute hang).
 */
export type HangingDeepLocatorMethod = "click" | "count" | "textContent";

interface Deferred {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
}

function createDeferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

interface HangGate {
  readonly hangOn: ReadonlySet<HangingDeepLocatorMethod>;
  readonly deferred: Deferred;
}

/**
 * Keyed by hop object (not selector) so hang behavior travels with
 * `registerDeepLocatorHangingHop`'s return value without widening
 * {@link FakeDeepLocatorHop}'s public shape — every existing consumer that
 * reads `clicks`/`filledWith`/`text` off a hop keeps seeing exactly that
 * shape, hung or not.
 */
const hangGates = new WeakMap<FakeDeepLocatorHop, HangGate>();

export interface RegisterDeepLocatorHangingHopOptions {
  /** Which method(s) resolve to a never-settling promise until `release()` is called. */
  readonly hangOn: HangingDeepLocatorMethod | readonly HangingDeepLocatorMethod[];
  /** Seeds `textContent()`'s eventual resolved value, same as {@link registerDeepLocatorHop}'s `text`. */
  readonly text?: string;
}

export interface FakeDeepLocatorHangingHop {
  readonly hop: FakeDeepLocatorHop;
  /**
   * Settles every promise this hop's hung methods have returned (and any it
   * returns afterward resolve immediately) — call in `afterEach` so a test
   * that registered a hang doesn't leave an unsettled promise behind for
   * the next test.
   */
  release(): void;
}

/**
 * Registers a hop selector whose `hangOn` methods resolve to a promise that
 * never settles on its own, while every other modeled method resolves
 * normally — the seam a watchdog/timeout-guard test needs to reproduce a
 * wedged `deepLocator().count()`/`.click()` CDP call without a real browser.
 */
export function registerDeepLocatorHangingHop(
  frame: FakeDeepLocatorFrame,
  selector: string,
  options: RegisterDeepLocatorHangingHopOptions
): FakeDeepLocatorHangingHop {
  const hop = registerDeepLocatorHop(frame, selector, options.text);
  const hangOn = new Set(Array.isArray(options.hangOn) ? options.hangOn : [options.hangOn]);
  const deferred = createDeferred();
  hangGates.set(hop, { hangOn, deferred });
  return { hop, release: deferred.resolve };
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
 * Builds a `deepLocator()`-shaped delegate resolving against `frame`, scoped
 * to a single `elementIndex` (defaulting to 0, matching the real delegate's
 * un-`nth()`-ed constructor default). Each call re-reads `frame.get(selector)`
 * (never caches), matching the real delegate's re-resolve-on-every-call
 * contract — a hop that attaches after construction (the mid-flow-iframe
 * scenario) still resolves once registered. `count()` reports the hop's full
 * `elements.length` regardless of `elementIndex`, mirroring the real
 * delegate: `nth(i).count()` still reports the total match count, not `1`.
 */
function buildFakeDelegate(
  frame: FakeDeepLocatorFrame,
  selector: string,
  elementIndex = 0
): FakeDeepLocatorDelegate {
  const requireElement = (): FakeDeepLocatorElement => {
    const hop = frame.get(selector);
    const element = hop?.elements[elementIndex];
    if (!element) throw new Error(`deepLocator: no element matches "${selector}"`);
    return element;
  };
  const awaitReleaseIfHungOn = async (method: HangingDeepLocatorMethod): Promise<void> => {
    const hop = frame.get(selector);
    const gate = hop ? hangGates.get(hop) : undefined;
    if (gate?.hangOn.has(method)) await gate.deferred.promise;
  };

  return {
    count: async () => {
      await awaitReleaseIfHungOn("count");
      return frame.get(selector)?.elements.length ?? 0;
    },
    click: async () => {
      await awaitReleaseIfHungOn("click");
      requireElement().clicks += 1;
    },
    fill: async (value: string) => {
      requireElement().filledWith = value;
    },
    textContent: async () => {
      await awaitReleaseIfHungOn("textContent");
      return requireElement().text;
    },
    first: () => buildFakeDelegate(frame, selector, 0),
    nth: (index: number) => buildFakeDelegate(frame, selector, index),
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
