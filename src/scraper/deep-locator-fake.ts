import type { DeepLocatorDelegate } from "@browserbasehq/stagehand/lib/v3/understudy/deepLocator.js";

import type { FrameCandidateScanResult } from "@/scraper/deep-locator-scan";

/**
 * One candidate element registered at a hop selector. `registerDeepLocatorHop`
 * seeds a single-element hop by constructing one of these; multi-candidate
 * hops (`registerDeepLocatorHopElements`) hold an ordered array of them so
 * `nth(i)` can resolve to a distinct element's own click/fill/text state
 * instead of collapsing every index onto shared scalars. `visible` models
 * whether the element has a layout box — `false` reproduces the run-7 field
 * condition of a candidate that exists in the DOM but has no rendered
 * geometry (0x0 box, `display:none`), which a real click rejects against
 * with the CDP `-32000 Node does not have a layout object` error
 * ({@link NODE_NOT_ACTIONABLE_MESSAGE}).
 */
export interface FakeDeepLocatorElement {
  clicks: number;
  filledWith: string | null;
  selectedWith: string[] | null;
  text: string;
  visible: boolean;
}

/**
 * Shorthand a caller can pass to {@link registerDeepLocatorHopElements}
 * instead of a bare string when an element also needs non-default layout
 * state — `visible` defaults to `true` (rendered) so every legacy
 * string-only registration keeps behaving exactly as it always has.
 */
export interface FakeDeepLocatorElementSpec {
  readonly text: string;
  readonly visible?: boolean;
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
  readonly selectedWith: string[] | null;
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
    get selectedWith() {
      return first.selectedWith;
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
 * `deepLocator(selector).count()` resolves to `elements.length` and
 * `nth(i).textContent()`/`nth(i).click()`/`nth(i).fill()` act on element `i`
 * specifically — the shape a real cross-origin OOPIF hop resolves to when
 * more than one element matches the inner selector (e.g. `"*"` matching
 * every node in the iframe), which the single-element
 * {@link registerDeepLocatorHop} path can't model. Each entry is either a
 * bare string (rendered, `visible: true`) or a
 * {@link FakeDeepLocatorElementSpec} for a candidate that also needs
 * non-default layout state — mixing both in one call models a hop where
 * only some candidates have a layout box, same as a real dense OOPIF form.
 */
export function registerDeepLocatorHopElements(
  frame: FakeDeepLocatorFrame,
  selector: string,
  elements: ReadonlyArray<string | FakeDeepLocatorElementSpec>
): FakeDeepLocatorHop {
  const built = elements.map((entry) => {
    const spec = typeof entry === "string" ? { text: entry } : entry;
    return {
      clicks: 0,
      filledWith: null,
      selectedWith: null,
      text: spec.text,
      visible: spec.visible ?? true,
    };
  });
  const hop = buildHop(built);
  frame.set(selector, hop);
  return hop;
}

/**
 * The `FakeDeepLocatorDelegate` methods `registerDeepLocatorHangingHop` can
 * pin open, modeling a wedged OOPIF CDP call (the run-6 78-minute hang).
 */
export type HangingDeepLocatorMethod = "click" | "count" | "fill" | "selectOption" | "textContent";

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
 * The delegate methods plus {@link makeFakeFrameScan}'s batched evaluate a
 * hop's {@link registerDeepLocatorHopLatency} profile can delay.
 */
export type LatencyDeepLocatorMethod = HangingDeepLocatorMethod | "scan";

export interface RegisterDeepLocatorHopLatencyOptions {
  /** Which method(s) resolve after `delayMs` instead of immediately. */
  readonly delayOn: LatencyDeepLocatorMethod | readonly LatencyDeepLocatorMethod[];
  readonly delayMs: number;
}

interface LatencyGate {
  readonly delayOn: ReadonlySet<LatencyDeepLocatorMethod>;
  readonly delayMs: number;
}

/**
 * Keyed by hop object (not selector), the same pattern {@link hangGates}
 * uses, so a finite per-call delay travels with a hop's return value without
 * widening {@link FakeDeepLocatorHop}'s public shape.
 */
const latencyGates = new WeakMap<FakeDeepLocatorHop, LatencyGate>();

async function delayIfRegistered(
  hop: FakeDeepLocatorHop | undefined,
  method: LatencyDeepLocatorMethod
): Promise<void> {
  const gate = hop ? latencyGates.get(hop) : undefined;
  if (!gate?.delayOn.has(method)) return;
  await new Promise<void>((resolve) => setTimeout(resolve, gate.delayMs));
}

/**
 * Attaches a finite per-call delay to an already-registered hop's `delayOn`
 * methods, leaving every other method — and every other hop — immediate.
 * This is the seam a test uses to prove the batched-scan fix collapses N
 * serial round-trips into one: register the same `delayMs` against
 * `"textContent"` (the legacy per-candidate path) and `"scan"` (the batched
 * path) on the same hop, then compare how enumeration time scales with
 * candidate count through each. Unlike {@link registerDeepLocatorHangingHop},
 * calls resolve on their own after `delayMs` — there is no `release()`.
 */
export function registerDeepLocatorHopLatency(
  hop: FakeDeepLocatorHop,
  options: RegisterDeepLocatorHopLatencyOptions
): void {
  const delayOn = new Set(Array.isArray(options.delayOn) ? options.delayOn : [options.delayOn]);
  latencyGates.set(hop, { delayOn, delayMs: options.delayMs });
}

/**
 * Only the methods `deep-locator-candidates.ts`'s actuation seams exercise:
 * `count()` to check candidate existence, `click()` (routed through
 * `src/scraper/flow-runner.ts`'s deepLocator call sites — `observe-act`,
 * rephrase evidence, the pre-cascade probe) plus `fill()`/`selectOption()`
 * (the `fillDeepLocatorCandidate`/`selectDeepLocatorCandidateOption` seams —
 * not yet routed by any flow-runner call site) to act, `textContent()` to
 * read `accessibleText`, `first()`/`nth()` for the same chaining
 * `buildHopSelector`-composed multi-match selectors need. `hover`/`type`/
 * `isVisible`/`isChecked`/`inputValue`/`innerHtml`/`innerText`/
 * `setInputFiles`/`scrollTo`/`centroid`/`backendNodeId`/`highlight`/
 * `sendClickEvent` are declared on the real `DeepLocatorDelegate` but no
 * planned call site routes through them, so they are omitted here — adding
 * one only when a call site actually needs it keeps this fake from drifting
 * out of sync with what's exercised.
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
  selectOption: DeepLocatorDelegate["selectOption"];
  textContent: DeepLocatorDelegate["textContent"];
  first(): FakeDeepLocatorDelegate;
  nth(index: number): FakeDeepLocatorDelegate;
}

/**
 * The literal CDP error message a real `DOM.getBoxModel`/
 * `DOM.scrollIntoViewIfNeeded` failure over "no layout object" arrives as
 * (`understudy/cdp.js`) — exported so both this fake's click rejection and a
 * consuming test assert against the same string bugfix-001's
 * `isNodeNotActionableError` (`deep-locator-scan.ts`) matches.
 */
export const NODE_NOT_ACTIONABLE_MESSAGE = "-32000 Node does not have a layout object";

/**
 * Builds a `deepLocator()`-shaped delegate resolving against `frame`, scoped
 * to a single `elementIndex` (defaulting to 0, matching the real delegate's
 * un-`nth()`-ed constructor default). Each call re-reads `frame.get(selector)`
 * (never caches), matching the real delegate's re-resolve-on-every-call
 * contract — a hop that attaches after construction (the mid-flow-iframe
 * scenario) still resolves once registered. `count()` reports the hop's full
 * `elements.length` regardless of `elementIndex`, mirroring the real
 * delegate: `nth(i).count()` still reports the total match count, not `1`.
 * `click()`/`fill()`/`selectOption()` each reject with
 * {@link NODE_NOT_ACTIONABLE_MESSAGE} when the targeted element's `visible`
 * is `false`, reproducing the CDP `-32000` actuation failure on an
 * unrendered node.
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
  const delayForMethod = (method: LatencyDeepLocatorMethod): Promise<void> =>
    delayIfRegistered(frame.get(selector), method);

  return {
    count: async () => {
      await delayForMethod("count");
      await awaitReleaseIfHungOn("count");
      return frame.get(selector)?.elements.length ?? 0;
    },
    click: async () => {
      await delayForMethod("click");
      await awaitReleaseIfHungOn("click");
      const element = requireElement();
      if (!element.visible) throw new Error(NODE_NOT_ACTIONABLE_MESSAGE);
      element.clicks += 1;
    },
    fill: async (value: string) => {
      await delayForMethod("fill");
      await awaitReleaseIfHungOn("fill");
      const element = requireElement();
      if (!element.visible) throw new Error(NODE_NOT_ACTIONABLE_MESSAGE);
      element.filledWith = value;
    },
    selectOption: async (values: string | string[]) => {
      await delayForMethod("selectOption");
      await awaitReleaseIfHungOn("selectOption");
      const element = requireElement();
      if (!element.visible) throw new Error(NODE_NOT_ACTIONABLE_MESSAGE);
      const selected = Array.isArray(values) ? values : [values];
      element.selectedWith = selected;
      return selected;
    },
    textContent: async () => {
      await delayForMethod("textContent");
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

/**
 * Fake frame-scoped batched evaluate bound to `selector` — models the seam
 * `resolveDeepLocatorCandidates`'s batched-scan fix calls once per frame via
 * `FrameTarget.evaluate(buildScanFrameCandidatesExpr(innerSelector))`
 * (`deep-locator-scan.ts`). Ignores whatever expression string it's called
 * with — a fake cannot execute browser-side code, and `deep-locator-scan.
 * test.ts`'s `node:vm` test is what proves the expression itself is correct
 * — and instead returns the hop registered at `selector` as
 * `FrameCandidateScanResult[]`, in registration order: the exact payload
 * shape a real `Frame.evaluate` call resolves to. Pass the result into a
 * fake `FrameTarget`'s `evaluate` field so a caller that reads through
 * `target.evaluate(...)` resolves against fixture state instead of a
 * browser.
 */
export function makeFakeFrameScan(
  frame: FakeDeepLocatorFrame,
  selector: string
): (expression?: unknown) => Promise<FrameCandidateScanResult[]> {
  return async () => {
    const hop = frame.get(selector);
    await delayIfRegistered(hop, "scan");
    if (!hop) return [];
    return hop.elements.map((element, index) => ({
      index,
      text: element.text,
      visible: element.visible,
    }));
  };
}
