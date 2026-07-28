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
  /**
   * When set, `inputValue()` returns this instead of `filledWith` — models a
   * write that doesn't stick (an SPA re-render normalizes/rejects the typed
   * value) so a read-back-verified actuator
   * (`fillDeepLocatorCandidate`/`selectDeepLocatorCandidateOption` in
   * `deep-locator-actuate.ts`) has a fixture to prove it returns `false`
   * rather than trusting the write blindly. Leave unset to have `inputValue()`
   * mirror whatever was last written.
   */
  readBackValue?: string;
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
 * `fill`/`selectOption`/`inputValue` model the same wedge for
 * `deep-locator-actuate.ts`'s write/read-back seam — e.g. a wedged `fill`
 * proving `fillDeepLocatorCandidate` rejects via its watchdog instead of
 * hanging.
 */
export type HangingDeepLocatorMethod =
  | "click"
  | "count"
  | "textContent"
  | "fill"
  | "selectOption"
  | "inputValue";

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
 * The delegate methods plus {@link makeFakeFrameScan}'s batched evaluate and
 * {@link makeFakeFrameClickByIndex}'s batched click a hop's
 * {@link registerDeepLocatorHopLatency} profile can delay.
 */
export type LatencyDeepLocatorMethod = HangingDeepLocatorMethod | "scan" | "clickByIndex";

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

/**
 * Charges `repeats` sequential `delayMs` round-trips when `method` is
 * registered against `hop`'s latency profile, immediate otherwise. `repeats`
 * defaults to 1 (a flat per-call cost) — {@link buildFakeDelegate} passes
 * `elementIndex + 1` for the methods that model Stagehand's per-index
 * resolve cost (see {@link INDEXED_RESOLVE_METHODS}), everything else stays
 * flat regardless of which index a caller chained `nth()` onto.
 */
async function delayIfRegistered(
  hop: FakeDeepLocatorHop | undefined,
  method: LatencyDeepLocatorMethod,
  repeats = 1
): Promise<void> {
  const gate = hop ? latencyGates.get(hop) : undefined;
  if (!gate?.delayOn.has(method)) return;
  for (let call = 0; call < repeats; call += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, gate.delayMs));
  }
}

/**
 * Attaches a finite per-call delay to an already-registered hop's `delayOn`
 * methods, leaving every other method — and every other hop — immediate.
 * This is the seam a test uses to prove a batched fix collapses N serial
 * round-trips into one: register the same `delayMs` against `"textContent"`/
 * `"click"`/`"fill"`/`"selectOption"`/`"inputValue"` (the legacy per-index
 * paths, charged `index + 1` times — see {@link INDEXED_RESOLVE_METHODS}) and
 * `"scan"`/`"clickByIndex"` (the batched paths, always charged once) on the
 * same hop, then compare how time scales
 * with candidate count/index through each. Unlike
 * {@link registerDeepLocatorHangingHop}, calls resolve on their own after
 * `delayMs` — there is no `release()`.
 */
export function registerDeepLocatorHopLatency(
  hop: FakeDeepLocatorHop,
  options: RegisterDeepLocatorHopLatencyOptions
): void {
  const delayOn = new Set(Array.isArray(options.delayOn) ? options.delayOn : [options.delayOn]);
  latencyGates.set(hop, { delayOn, delayMs: options.delayMs });
}

/**
 * Only the methods `src/scraper/flow-runner.ts`'s deepLocator-routed call
 * sites (`observe-act`, rephrase evidence, the pre-cascade probe) actually
 * invoke, via `deep-locator-candidates.ts`: `count()` to check candidate
 * existence, `click()` to act, `textContent()` to read `accessibleText`,
 * `first()`/`nth()` for the same chaining `buildHopSelector`-composed
 * multi-match selectors need. `fill()`/`selectOption()`/`inputValue()` back
 * `deep-locator-actuate.ts`'s fill/select actuation seam — the write
 * primitives and the read-back that confirms a write stuck. `hover`/`type`/
 * `isVisible`/`isChecked`/`innerHtml`/`innerText`/
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
  inputValue: DeepLocatorDelegate["inputValue"];
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
 * The delegate methods whose real cost scales with the resolved index:
 * Stagehand 3.7.0's `resolveAtIndex(query, index)` calls
 * `resolveAll(query, {limit: index + 1})`, whose `resolveCss` runs
 * `for (let i = 0; i < limit; i += 1) { await this.evaluateElement(...) }`
 * (`selectorResolver.js`) — one serial CDP `Runtime.evaluate` per index, so
 * `nth(k)` pays `k + 1` round-trips, not one. That resolve path is shared by
 * every `nth()`-scoped delegate method, not just `click`/`textContent` —
 * `fill`/`selectOption`/`inputValue` resolve the target element through the
 * exact same `resolveAtIndex` call before writing/reading it, so they pay the
 * identical `k + 1` cost. `count()` resolves the whole match set once
 * regardless of which index a caller later chains `nth()` onto, so it — and
 * every other modeled method — stays a flat one-call cost.
 */
const INDEXED_RESOLVE_METHODS: ReadonlySet<LatencyDeepLocatorMethod> = new Set([
  "click",
  "textContent",
  "fill",
  "selectOption",
  "inputValue",
]);

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
 * unrendered node. `click()`/`textContent()`/`fill()`/`selectOption()`/
 * `inputValue()` charge `elementIndex + 1` delay units under a registered
 * latency profile (see {@link INDEXED_RESOLVE_METHODS}), modeling
 * Stagehand's per-index resolve cost — every other method stays a flat
 * one-call cost.
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
    delayIfRegistered(
      frame.get(selector),
      method,
      INDEXED_RESOLVE_METHODS.has(method) ? elementIndex + 1 : 1
    );

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
    inputValue: async () => {
      await delayForMethod("inputValue");
      await awaitReleaseIfHungOn("inputValue");
      const element = requireElement();
      return element.readBackValue ?? element.selectedWith?.[0] ?? element.filledWith ?? "";
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
 * Minimal fake DOM element supporting exactly the surface
 * {@link buildScanFrameCandidatesExpr} (`deep-locator-scan.ts`) touches:
 * `textContent`, `getBoundingClientRect`, `getAttribute`, `closest`, plus a
 * `computedStyle` bag the fake global `getComputedStyle` reads from. Shared
 * here (not duplicated per test file) so `deep-locator-scan.dense-form.
 * test.ts` and Stagehand-contract tests can execute the SAME generated
 * expression against the SAME fixture shape as `deep-locator-scan.test.ts`'s
 * own hand-built fixture. `value`/`dispatchEvent`/`focus` model the write
 * half of that same contract — a generated fill/select expression reads and
 * writes `el.value` and fires bubbling `input`/`change`/`blur` events the
 * same way `flow-runner.ts`'s existing `.value =` + `dispatchEvent` write
 * paths do, so a fake candidate can stand in for a real writable `<input>`/
 * `<select>` instead of only the read-only surface a click/scan needs.
 */
export interface FakeDomElement {
  readonly textContent: string;
  readonly tagName: string;
  readonly attributes: Readonly<Record<string, string>>;
  readonly rect: { readonly width: number; readonly height: number };
  readonly computedStyle: { readonly display: string; readonly visibility: string };
  readonly parent: FakeDomElement | null;
  value: string;
  /** `<select>`-only: the `<option>` collection {@link buildSelectFrameCandidateExpr}'s (`deep-locator-scan.ts`) value-then-label match reads. Empty for every non-`<select>` fixture. */
  readonly options: readonly { readonly value: string; readonly textContent: string }[];
  readonly dispatchedEvents: readonly string[];
  getBoundingClientRect(): { readonly width: number; readonly height: number };
  getAttribute(name: string): string | null;
  closest(selector: string): FakeDomElement | null;
  dispatchEvent(event: { readonly type: string }): boolean;
  focus(): void;
}

/** Fake `document`/frame-document surface: the two lookups the accessible-name precedence chain needs beyond the matched candidate set itself. */
export interface FakeDomRoot {
  querySelectorAll(selector: string): FakeDomElement[];
  getElementById(id: string): FakeDomElement | null;
}

/** Optional overrides {@link makeFakeDomElement} accepts beyond its default rendered `div`. */
export interface MakeFakeDomElementOptions {
  readonly tagName?: string;
  readonly attributes?: Record<string, string>;
  readonly rect?: { readonly width: number; readonly height: number };
  readonly computedStyle?: { readonly display: string; readonly visibility: string };
  readonly parent?: FakeDomElement | null;
  /** Seeds `value` — the initial `.value` a write expression reads before overwriting it. Defaults to `""`, matching an unfilled `<input>`. */
  readonly value?: string;
  /** Seeds `options` — a `<select>` fixture's option collection. Defaults to `[]`, matching every non-`<select>` element. */
  readonly options?: readonly { readonly value: string; readonly textContent: string }[];
}

/** Parses one simple-selector clause — a bare tag, `[attr]`, or `[attr=value]` — the three shapes {@link INTERACTIVE_CANDIDATE_SELECTOR} composes via commas. No combinators, descendant selectors, or pseudo-classes: the generated expression only ever calls `querySelectorAll` with a flat, comma-joined clause list. */
function parseSimpleSelectorClause(
  clause: string
): { readonly tag: string } | { readonly attr: string; readonly value: string | null } {
  const trimmed = clause.trim();
  const attrMatch = /^\[([a-zA-Z-]+)(?:=(.*))?\]$/.exec(trimmed);
  if (!attrMatch) return { tag: trimmed.toLowerCase() };
  const [, attr, rawValue] = attrMatch;
  const value = rawValue === undefined ? null : rawValue.replace(/^["']|["']$/g, "");
  return { attr: attr ?? "", value };
}

/** Matches `el` against one comma-separated clause of a selector — the attribute-aware step {@link makeSelectorAwareDomRoot}'s `querySelectorAll` and {@link makeFakeDomElement}'s `closest` both need beyond a bare tag-name comparison. */
function matchesSelectorClause(el: FakeDomElement, clause: string): boolean {
  const parsed = parseSimpleSelectorClause(clause);
  if ("tag" in parsed) return el.tagName.toLowerCase() === parsed.tag;
  const attrValue = el.getAttribute(parsed.attr);
  if (attrValue === null) return false;
  return parsed.value === null || attrValue === parsed.value;
}

/** `true` when `el` matches any comma-separated clause of `selector` — the full `querySelectorAll(selector)` predicate. */
function matchesSelector(el: FakeDomElement, selector: string): boolean {
  return selector.split(",").some((clause) => matchesSelectorClause(el, clause));
}

/**
 * Builds one fake DOM element. Defaults model a rendered, tag-less `div`
 * with no accessible-name signal — the "structural filler" shape a dense
 * form fixture needs many of — so a caller building a large fixture only
 * spells out the overrides that make a specific element interesting.
 */
export function makeFakeDomElement(
  textContent = "",
  options: MakeFakeDomElementOptions = {}
): FakeDomElement {
  const tagName = options.tagName ?? "div";
  const attributes = options.attributes ?? {};
  const rect = options.rect ?? { width: 100, height: 20 };
  const computedStyle = options.computedStyle ?? { display: "block", visibility: "visible" };
  const parent = options.parent ?? null;
  const dispatchedEvents: string[] = [];
  const el: FakeDomElement = {
    textContent,
    tagName,
    attributes,
    rect,
    computedStyle,
    parent,
    value: options.value ?? "",
    options: options.options ?? [],
    dispatchedEvents,
    getBoundingClientRect() {
      return rect;
    },
    getAttribute(name) {
      return attributes[name] ?? null;
    },
    closest(selector) {
      const found = (node: FakeDomElement | null): FakeDomElement | null => {
        if (!node) return null;
        return matchesSelector(node, selector) ? node : found(node.parent);
      };
      return found(el);
    },
    dispatchEvent(event) {
      dispatchedEvents.push(event.type);
      return true;
    },
    focus() {},
  };
  return el;
}

/**
 * Builds a selector-aware fake `document` root: `querySelectorAll` supports
 * the exact clause shapes {@link INTERACTIVE_CANDIDATE_SELECTOR} needs (a
 * bare tag, `[attr]`, `[attr=value]`, comma-joined, or `"*"`) instead of
 * `deep-locator-scan.test.ts`'s tag-only `makeRoot`, so a fixture exercising
 * that constant's `[role=button]` / `[tabindex]` clauses actually selects
 * against them.
 */
export function makeSelectorAwareDomRoot(elements: readonly FakeDomElement[]): FakeDomRoot {
  return {
    querySelectorAll(selector) {
      if (selector.trim() === "*") return [...elements];
      return elements.filter((el) => matchesSelector(el, selector));
    },
    getElementById(id) {
      return elements.find((el) => el.getAttribute("id") === id) ?? null;
    },
  };
}

/** Total node count {@link buildDenseFormFixture} produces — the live-measured `#talemetry_apply_iframe >> *` match count from the uchealth-7 bug report. */
export const DENSE_FORM_TOTAL_COUNT = 371;

/** Accessible name {@link buildDenseFormFixture}'s icon-only target button resolves to — mirrors the live report's `button.c-SocialButton-button-25:has(svg[data-testid='EditIcon'])` control, modeled here as a plain icon-only `button` named via `aria-label` since `:has()` support is not what this fixture is for. */
export const DENSE_FORM_TARGET_TEXT = "Manual Application";

/** Accessible names of {@link buildDenseFormFixture}'s two unrendered decoys — one `display:none`, one a 0x0 layout box — the two shapes a real click rejects with the CDP `-32000 Node does not have a layout object` error. */
export const DENSE_FORM_DECOY_TEXTS = ["Upload a Resume/CV", "Use LinkedIn Profile"] as const;

/** {@link buildDenseFormFixture}'s return shape: the assembled root plus its flat element list, so a caller can assert against fixture composition (e.g. total count) without re-deriving it from the root. */
export interface DenseFormFixture {
  readonly root: FakeDomRoot;
  readonly elements: readonly FakeDomElement[];
}

/**
 * Builds the {@link DENSE_FORM_TOTAL_COUNT}-node dense-OOPIF-shaped fixture
 * the uchealth-7 bug report measured (`#talemetry_apply_iframe >> *`
 * matching 371 elements): mostly structural `div`/`span` filler, a handful
 * of real form controls, an icon-only target button, and two unrendered
 * decoys. Exported (not inlined per test file) so `test-002`'s Stagehand-
 * resolver-contract pin can run the installed dependency's own resolver
 * against the IDENTICAL fixture `deep-locator-scan.dense-form.test.ts`
 * proves {@link buildScanFrameCandidatesExpr} against.
 */
export function buildDenseFormFixture(): DenseFormFixture {
  const [uploadDecoyText, linkedinDecoyText] = DENSE_FORM_DECOY_TEXTS;
  const structuralCount =
    DENSE_FORM_TOTAL_COUNT -
    6 /* firstName, country, coverLetter, learnMore, saveDraft, moreOptions */ -
    1 /* target */ -
    2 /* decoys */;
  const structural = Array.from({ length: structuralCount }, (_, index) =>
    makeFakeDomElement("", { tagName: index % 2 === 0 ? "div" : "span" })
  );
  const firstName = makeFakeDomElement("", {
    tagName: "input",
    attributes: { "aria-label": "First Name" },
  });
  const country = makeFakeDomElement("", {
    tagName: "select",
    attributes: { "aria-label": "Country" },
  });
  const coverLetter = makeFakeDomElement("", {
    tagName: "textarea",
    attributes: { "aria-label": "Cover Letter" },
  });
  const learnMore = makeFakeDomElement("Learn more", { tagName: "a", attributes: { href: "#" } });
  const saveDraft = makeFakeDomElement("Save Draft", {
    tagName: "div",
    attributes: { role: "button" },
  });
  const moreOptions = makeFakeDomElement("More options", {
    tagName: "div",
    attributes: { tabindex: "0" },
  });
  const target = makeFakeDomElement("", {
    tagName: "button",
    attributes: { "aria-label": DENSE_FORM_TARGET_TEXT },
  });
  const uploadDecoy = makeFakeDomElement(uploadDecoyText, {
    tagName: "button",
    computedStyle: { display: "none", visibility: "visible" },
  });
  const linkedinDecoy = makeFakeDomElement(linkedinDecoyText, {
    tagName: "button",
    rect: { width: 0, height: 0 },
  });

  const elements = [
    ...structural,
    firstName,
    country,
    coverLetter,
    learnMore,
    saveDraft,
    moreOptions,
    uploadDecoy,
    linkedinDecoy,
    target,
  ];

  return { root: makeSelectorAwareDomRoot(elements), elements };
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

/**
 * Result of the fake batched click-by-index seam
 * ({@link makeFakeFrameClickByIndex}): `clicked` mirrors whether the click
 * landed on a rendered node. `reason` is set instead of the fake throwing —
 * a single batched evaluate call reports what it observed rather than
 * surfacing a per-call CDP rejection — and carries
 * {@link NODE_NOT_ACTIONABLE_MESSAGE} for the unrendered-node case so a
 * caller can still classify it via {@link isNodeNotActionableError}
 * (`deep-locator-scan.ts`).
 */
export interface FakeBatchedClickResult {
  clicked: boolean;
  reason?: string;
}

/**
 * Fake frame-scoped batched click-by-index bound to `selector` — models the
 * seam a click-by-index fix would call once per click via a single frame
 * evaluate, instead of the legacy delegate's `nth(index).click()` walking
 * `resolveAtIndex`'s serial per-index loop (see {@link INDEXED_RESOLVE_METHODS}).
 * Same "ignore the expression string, resolve against the hop registry"
 * contract as {@link makeFakeFrameScan}: a fake cannot execute browser-side
 * code, so the `expression` argument is accepted (mirroring `evaluate`'s
 * signature) but never inspected. Increments `elements[index].clicks` when
 * the targeted element is registered and `visible`, so an assertion like
 * `hop.elements[i]?.clicks` reads the same regardless of which click path a
 * consumer routes through. Resolves `{ clicked: false, reason }` — never
 * throws — when `index` doesn't resolve to a registered element (hop
 * unregistered, or `index` out of range) or the element is `visible: false`.
 */
export function makeFakeFrameClickByIndex(
  frame: FakeDeepLocatorFrame,
  selector: string
): (index: number, expression?: unknown) => Promise<FakeBatchedClickResult> {
  return async (index: number) => {
    const hop = frame.get(selector);
    await delayIfRegistered(hop, "clickByIndex");
    const element = hop?.elements[index];
    if (!element) return { clicked: false, reason: `deepLocator: no element at index ${index}` };
    if (!element.visible) return { clicked: false, reason: NODE_NOT_ACTIONABLE_MESSAGE };
    element.clicks += 1;
    return { clicked: true };
  };
}
