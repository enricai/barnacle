/**
 * Cross-origin OOPIF candidate resolver: `observe()` returns zero candidates
 * for a cross-origin OOPIF (measured against a live Talemetry wizard embed —
 * see the frame-scoped iframe bug report), even though the frame is fully
 * attached and reachable. `page.deepLocator()` is Stagehand's own
 * hop-notation resolver and is measured to both locate and actuate elements
 * inside that same OOPIF, so this module is the single seam every
 * frame-scoped flow-runner call site uses instead of `observe()`/`act()`
 * when the step is scoped to a child frame.
 */

import type { Page } from "@browserbasehq/stagehand";

import { toErrorMessage } from "@/lib/errors";
import { getLogger } from "@/lib/logging";
import {
  buildScanFrameCandidatesExpr,
  type FrameCandidateScanResult,
} from "@/scraper/deep-locator-scan";
import { buildHopSelector, type FrameTarget, resolveFrameTarget } from "@/scraper/frame-target";
import { withWatchdog } from "@/scraper/watchdog";

const logger = getLogger({ name: "scraper/deep-locator-candidates" });

/**
 * Per-CDP-call watchdog default: bounds a single `count()`/`nth().textContent()`/
 * `nth().click()` round-trip. Owned locally (not imported from
 * `flow-runner.ts`'s `STEP_WATCHDOG_MS`) to avoid the import cycle —
 * `flow-runner.ts` imports this module.
 */
const DEFAULT_DEEP_LOCATOR_CALL_TIMEOUT_MS = 10_000;

/**
 * Total wall-clock budget for {@link resolveDeepLocatorCandidates}'s legacy
 * per-candidate `textContent()` enumeration loop — the fallback path taken
 * when no batched frame-scoped scan is available (see
 * {@link DeepLocatorTimeoutOptions.frameTarget}). A hop like `"*"` can match
 * dozens of elements (65 observed against a live OOPIF) — each individually
 * fast but settling, not hanging — so a per-call timeout alone doesn't bound
 * the loop's total cost. Roughly half of `flow-runner.ts`'s
 * `STEP_WATCHDOG_MS` (120s), leaving headroom for the rest of the attempt.
 * The batched scan path completes in one round-trip and is never gated by
 * this budget.
 */
const DEFAULT_DEEP_LOCATOR_ENUMERATION_BUDGET_MS = 60_000;

/** Overrides for the watchdog timeouts this module applies to every `deepLocator()` await; tests pass small values so cases don't burn wall-clock. */
export interface DeepLocatorTimeoutOptions {
  /** Per-call watchdog timeout for `count()`/`textContent()`/`click()`. Defaults to {@link DEFAULT_DEEP_LOCATOR_CALL_TIMEOUT_MS}. */
  callTimeoutMs?: number;
  /** Total budget for {@link resolveDeepLocatorCandidates}'s legacy enumeration loop. Defaults to {@link DEFAULT_DEEP_LOCATOR_ENUMERATION_BUDGET_MS}. */
  enumerationBudgetMs?: number;
  /**
   * Pre-resolved `FrameTarget` to scan via one batched
   * `evaluate(buildScanFrameCandidatesExpr(innerSelector))` round-trip
   * instead of the legacy `count()` + per-candidate `textContent()` loop.
   * When omitted, a single non-polling `resolveFrameTarget(page, frameSelector,
   * { timeoutMs: 0 })` pass is attempted internally so existing call sites
   * get the batched fast path for free; if that pass doesn't land a resolved
   * child frame (not yet attached, or `frameSelector` is null/undefined), the
   * legacy loop runs unchanged. A caller that already resolved a `FrameTarget`
   * (e.g. `flow-runner.ts`'s per-step resolution) should pass it here to skip
   * the redundant internal resolution pass.
   */
  frameTarget?: FrameTarget;
}

/** `page.deepLocator()`'s return type, without importing Stagehand's understudy internals directly. */
type DeepLocatorInstance = ReturnType<NonNullable<Page["deepLocator"]>>;

/**
 * One candidate element `page.deepLocator()` resolved inside a scoped frame.
 * `selector` carries the `deeplocator=`-prefixed hop notation (NOT `xpath=`)
 * so downstream code can synthesize a `resolvedAction` for logging/telemetry
 * the same way `deep-submit-locator` and `structured-click` do, while
 * `xpathBody()` (`flow-runner.ts`) correctly returns `null` for it — hop
 * notation like `iframe#id >> * >> nth=0` is not XPath, and even a genuine
 * XPath here could never be evaluated correctly by `document.evaluate`
 * (which only ever queries the top-level `document`, not a cross-origin
 * OOPIF's own document) — so the selector must not claim the `xpath=`
 * contract it can't honor.
 */
export interface DeepLocatorCandidate {
  /** Positional index into the `deepLocator(hopSelector)` result set — pass to {@link clickDeepLocatorCandidate} to act on this exact candidate. */
  index: number;
  /** `deeplocator=`-prefixed selector identifying this candidate for downstream `resolvedAction` synthesis; deliberately not `xpath=` (see {@link DeepLocatorCandidate} docs). */
  selector: string;
  /**
   * Accessible text for this candidate: the derived accessible name (see
   * {@link buildScanFrameCandidatesExpr}) on the batched-scan fast path,
   * or the delegate's raw `textContent()` on the legacy per-candidate
   * enumeration fallback.
   */
  accessibleText: string;
}

/**
 * Composes the display/telemetry selector for candidate `index` at
 * `hopSelector`: a positional `nth` predicate over the hop scope, since
 * `DeepLocatorDelegate` exposes no way to read back the concrete XPath a
 * given index resolved to. Prefixed `deeplocator=` (not `xpath=`) so
 * `flow-runner.ts`'s `xpathBody()` never mistakes hop notation for XPath and
 * attempts to run it through `document.evaluate`.
 */
function candidateSelector(hopSelector: string, index: number): string {
  return `deeplocator=${hopSelector} >> nth=${index}`;
}

/**
 * Words that flip a quoted phrase from "target this" to "do not target
 * this" when they appear earlier in the instruction than the phrase itself.
 * Matches the flow-authoring convention observed in acceptance instructions
 * (e.g. "Do NOT click 'Upload a Resume/CV', 'Use LinkedIn Profile', ...").
 */
const NEGATION_MARKERS = /\b(?:do\s+not|don't|never|avoid)\b/gi;

/**
 * Extracts every single-quoted phrase from `instruction`, tagging each as
 * negated when a negation marker (`NEGATION_MARKERS`) precedes it within the
 * same sentence — flow instructions keep each "Do NOT click 'X', 'Y', ..."
 * clause as one sentence listing every negated phrase, so a sentence
 * boundary (`.`/`;`) between the marker and the phrase ends the negation's
 * reach. Mirrors the quoted-phrase extraction convention in
 * `parseSelectStep`/`parseRadioStep` (`flow-runner.ts`) — same
 * `/'([^']+)'/g` shape — but here we need ALL quoted phrases plus their
 * polarity, not just one option/label pair.
 */
function extractTaggedPhrases(instruction: string): Array<{ text: string; negated: boolean }> {
  const negationStarts = [...instruction.matchAll(NEGATION_MARKERS)].map((m) => m.index);
  const quoted = [...instruction.matchAll(/'([^']+)'/g)];
  return quoted.map((m) => {
    // biome-ignore lint/style/noNonNullAssertion: m.index is always defined for matchAll results
    const phraseStart = m.index!;
    const nearestNegationBefore = negationStarts.filter((idx) => idx < phraseStart).at(-1);
    const negated =
      nearestNegationBefore !== undefined &&
      !/[.;]/.test(instruction.slice(nearestNegationBefore, phraseStart));
    // biome-ignore lint/style/noNonNullAssertion: capture group 1 is required by the pattern, so it is present on every match
    return { text: m[1]!.trim(), negated };
  });
}

/** Normalizes text for relevance comparison: lowercase, whitespace-collapsed. */
function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * Scores one candidate's relevance to `instruction`'s tagged phrases, higher
 * is more relevant. Mirrors `submit-control.ts`'s tiered-ranking shape:
 * negative signal is checked first and wins outright (a candidate matching
 * ANY negated phrase is actively demoted below "no match" — a decoy sibling
 * button is worse than an unrelated structural node), then positive
 * exact/substring match tiers, falling through to 0 for empty or
 * unrelated text so a structural container with no accessible text can
 * never outrank a candidate whose text actually matches the instruction.
 */
function scoreCandidate(
  accessibleText: string,
  phrases: Array<{ text: string; negated: boolean }>
): number {
  const normalizedText = normalize(accessibleText);
  if (!normalizedText) return 0;
  const positives = phrases.filter((p) => !p.negated).map((p) => normalize(p.text));
  const negatives = phrases.filter((p) => p.negated).map((p) => normalize(p.text));
  if (negatives.some((n) => n === normalizedText || normalizedText.includes(n))) return -1;
  if (positives.some((p) => p === normalizedText)) return 3;
  if (positives.some((p) => normalizedText.includes(p) || p.includes(normalizedText))) return 2;
  return 0;
}

/**
 * Resolves the `FrameTarget` the batched scan should evaluate against:
 * `timeoutOptions.frameTarget` when the caller already resolved one, else a
 * single non-polling `resolveFrameTarget` pass (`timeoutMs: 0`) so existing
 * call sites — which pass only a `frameSelector` string, not a `FrameTarget`
 * — still get the batched fast path without themselves changing. Returns
 * `null` (never throws) when `frameSelector` is unset, resolution rejects
 * (e.g. a fake `Page` in a legacy-path test lacking `evaluate`/`frames`), or
 * the pass lands on the main-frame fallback rather than an attached child
 * frame — each of those means "no frame seam available", and the caller
 * degrades to the legacy per-candidate loop.
 */
async function resolveScanFrameTarget(
  page: Page,
  frameSelector: string | null | undefined,
  timeoutOptions: DeepLocatorTimeoutOptions
): Promise<FrameTarget | null> {
  if (timeoutOptions.frameTarget) return timeoutOptions.frameTarget;
  if (!frameSelector) return null;
  try {
    const resolved = await resolveFrameTarget(page, frameSelector, { timeoutMs: 0 });
    return resolved?.frame ? resolved : null;
  } catch {
    return null;
  }
}

/** Narrows a batched-scan evaluate result to {@link FrameCandidateScanResult}'s shape, guarding against a non-conforming payload (Issue #2's degrade-to-legacy-loop contract). */
function isFrameCandidateScanResult(entry: unknown): entry is FrameCandidateScanResult {
  if (typeof entry !== "object" || entry === null) return false;
  const candidate = entry as Partial<FrameCandidateScanResult>;
  return (
    typeof candidate.index === "number" &&
    typeof candidate.text === "string" &&
    typeof candidate.visible === "boolean"
  );
}

/**
 * Batched-scan fast path: one `frameTarget.evaluate(buildScanFrameCandidatesExpr(innerSelector))`
 * round-trip replaces the legacy `count()` + N × `nth(i).textContent()` loop.
 * Returns `null` (never throws) when no frame seam is available, the
 * evaluate call rejects (missing seam, thrown error, or a watchdog timeout —
 * `frameTarget.evaluate` already carries its own watchdog), or the resolved
 * payload doesn't conform to {@link FrameCandidateScanResult}[] — every one
 * of those degrades the caller to the legacy loop instead of losing
 * candidates. Filters out `visible:false` entries (Issue #2: an unrendered
 * node can never be the target of a real click) before the caller ranks
 * what's left, logging at `warn` when candidates are dropped so a frame
 * whose every node reports unrendered doesn't silently look like an empty
 * frame.
 */
async function scanFrameCandidatesBatched(
  page: Page,
  frameSelector: string | null | undefined,
  innerSelector: string,
  hopSelector: string,
  timeoutOptions: DeepLocatorTimeoutOptions
): Promise<DeepLocatorCandidate[] | null> {
  const frameTarget = await resolveScanFrameTarget(page, frameSelector, timeoutOptions);
  if (!frameTarget) return null;

  let scanResults: unknown;
  try {
    scanResults = await frameTarget.evaluate<FrameCandidateScanResult[]>(
      buildScanFrameCandidatesExpr(innerSelector)
    );
  } catch (err) {
    logger.warn(
      `deepLocator batched scan for ${hopSelector} failed, degrading to per-candidate enumeration: ${toErrorMessage(err)}`
    );
    return null;
  }
  if (!Array.isArray(scanResults) || !scanResults.every(isFrameCandidateScanResult)) {
    logger.warn(
      `deepLocator batched scan for ${hopSelector} returned a non-conforming payload, degrading to per-candidate enumeration`
    );
    return null;
  }

  const visibleResults = scanResults.filter((entry) => entry.visible);
  if (visibleResults.length < scanResults.length) {
    logger.warn(
      `deepLocator batched scan for ${hopSelector} dropped ${scanResults.length - visibleResults.length} unrendered candidate(s)`
    );
  }
  return visibleResults.map((entry) => ({
    index: entry.index,
    selector: candidateSelector(hopSelector, entry.index),
    accessibleText: entry.text.trim(),
  }));
}

/**
 * Legacy fallback: `count()` then one `nth(index).textContent()` round-trip
 * per candidate, individually bounded by `callTimeoutMs` via
 * {@link withWatchdog} and collectively bounded by `enumerationBudgetMs` so a
 * hop with dozens of slow-but-settling elements (e.g. 65 candidates matched
 * against a live OOPIF) can't rack up an unbounded total cost even when no
 * single call hangs — the loop aborts early and returns whatever candidates
 * it already resolved. Never throws: a `count()`/`textContent()` failure
 * (detached frame, navigated-away element) or either call exceeding its
 * watchdog budget degrades to `[]`/an empty `accessibleText`.
 */
async function enumerateCandidatesViaLegacyLoop(
  delegate: DeepLocatorInstance,
  hopSelector: string,
  callTimeoutMs: number,
  enumerationBudgetMs: number
): Promise<DeepLocatorCandidate[]> {
  const count = await withWatchdog(() => delegate.count(), {
    timeoutMs: callTimeoutMs,
    label: `deepLocator count() for ${hopSelector}`,
  }).catch((err: unknown) => {
    logger.warn(`deepLocator count() threw for ${hopSelector}: ${toErrorMessage(err)}`);
    return 0;
  });
  if (count === 0) return [];

  const candidates: DeepLocatorCandidate[] = [];
  const enumerationDeadline = Date.now() + enumerationBudgetMs;
  for (let index = 0; index < count; index++) {
    if (Date.now() >= enumerationDeadline) {
      logger.warn(
        `deepLocator enumeration for ${hopSelector} aborted after exceeding ${enumerationBudgetMs}ms budget at candidate ${index}/${count}`
      );
      break;
    }
    const accessibleText = await withWatchdog(() => delegate.nth(index).textContent(), {
      timeoutMs: callTimeoutMs,
      label: `deepLocator textContent() for ${hopSelector} nth=${index}`,
    }).catch(() => "");
    candidates.push({
      index,
      selector: candidateSelector(hopSelector, index),
      accessibleText: accessibleText.trim(),
    });
  }
  return candidates;
}

/**
 * Enumerates every element `page.deepLocator()` matches inside the frame
 * scoped by `frameSelector`, ranked by relevance to `instruction` (highest
 * first, ties preserving original delegate/DOM order). Composes the hop
 * scope via `buildHopSelector` (owned by `frame-target.ts`) rather than
 * string-concatenating `>>` itself, so hop notation stays defined in exactly
 * one place. Never throws: a missing `page.deepLocator`, a
 * `count()`/`nth()`/`textContent()` failure (detached frame, navigated-away
 * element), or either call exceeding its watchdog budget (a wedged CDP
 * round-trip against a racy OOPIF frame — see the deepLocator-direct-hangs
 * bug report) degrades to `[]`/an empty `accessibleText` so a caller
 * cascading through candidate sources can move on to the next technique
 * instead of hanging the step forever.
 *
 * Prefers a single batched `evaluate` round-trip over the frame
 * (see {@link scanFrameCandidatesBatched}) — collapsing the O(n) per-candidate
 * `textContent()` round-trips that made a dense OOPIF form (371 candidates
 * measured live) unresolvable inside any reasonable budget — and falls back
 * to the legacy `count()` + per-candidate loop (see
 * {@link enumerateCandidatesViaLegacyLoop}) only when no frame seam is
 * available or the batched scan fails. Pass an already-resolved
 * {@link DeepLocatorTimeoutOptions.frameTarget} to use the fast path without
 * paying for an internal re-resolution.
 *
 * Ranking exists because a hop like `"*"` matches every element inside a
 * wizard iframe (html, body, every div, ...) — DOM order alone almost always
 * puts a structural container first, not the control the step instruction
 * actually names. Pass `instruction` as `null`/`undefined` (or omit it) to
 * skip ranking and get delegate order — e.g. for pre-cascade reachability
 * probes that only care whether the frame has ANY candidates.
 */
export async function resolveDeepLocatorCandidates(
  page: Page,
  frameSelector: string | null | undefined,
  innerSelector: string,
  instruction?: string | null,
  timeoutOptions: DeepLocatorTimeoutOptions = {}
): Promise<DeepLocatorCandidate[]> {
  const callTimeoutMs = timeoutOptions.callTimeoutMs ?? DEFAULT_DEEP_LOCATOR_CALL_TIMEOUT_MS;
  const enumerationBudgetMs =
    timeoutOptions.enumerationBudgetMs ?? DEFAULT_DEEP_LOCATOR_ENUMERATION_BUDGET_MS;
  const hopSelector = buildHopSelector(frameSelector, innerSelector);
  const delegate = typeof page.deepLocator === "function" ? page.deepLocator(hopSelector) : null;
  if (!delegate) {
    logger.warn(`deepLocator() is unavailable on this page for ${hopSelector}`);
    return [];
  }

  const batchedCandidates = await scanFrameCandidatesBatched(
    page,
    frameSelector,
    innerSelector,
    hopSelector,
    timeoutOptions
  );
  const candidates =
    batchedCandidates ??
    (await enumerateCandidatesViaLegacyLoop(
      delegate,
      hopSelector,
      callTimeoutMs,
      enumerationBudgetMs
    ));
  if (!instruction) return candidates;

  const phrases = extractTaggedPhrases(instruction);
  if (phrases.length === 0) return candidates;

  return candidates
    .map((candidate, originalOrder) => ({
      candidate,
      originalOrder,
      score: scoreCandidate(candidate.accessibleText, phrases),
    }))
    .sort((a, b) => b.score - a.score || a.originalOrder - b.originalOrder)
    .map(({ candidate }) => candidate);
}

/**
 * Clicks the candidate at `index` inside the frame scoped by `frameSelector`,
 * re-deriving the same hop selector `resolveDeepLocatorCandidates` used
 * rather than trusting a caller-supplied `xpath=` string, so the two stay in
 * lockstep even if a candidate's `selector` field is only ever used for
 * display/logging. `DeepLocatorDelegate.click()` resolves `Promise<void>` on
 * success and rejects on failure — it never reports success via a return
 * value — so callers must infer the outcome from whether this call throws
 * plus their own downstream DOM verification, not from a returned boolean.
 * A `click()` that exceeds `timeoutOptions.callTimeoutMs` (a wedged CDP
 * round-trip against a racy OOPIF frame) rejects with a `WatchdogTimeoutError`
 * the same as any other failure, preserving the "rejects on failure" contract
 * instead of hanging the caller forever.
 */
export async function clickDeepLocatorCandidate(
  page: Page,
  frameSelector: string | null | undefined,
  innerSelector: string,
  index: number,
  timeoutOptions: DeepLocatorTimeoutOptions = {}
): Promise<void> {
  const callTimeoutMs = timeoutOptions.callTimeoutMs ?? DEFAULT_DEEP_LOCATOR_CALL_TIMEOUT_MS;
  const hopSelector = buildHopSelector(frameSelector, innerSelector);
  await withWatchdog(() => page.deepLocator(hopSelector).nth(index).click(), {
    timeoutMs: callTimeoutMs,
    label: `deepLocator click() for ${hopSelector} nth=${index}`,
  });
}

/**
 * Fills the candidate at `index` inside the frame scoped by `frameSelector`
 * with `value`, re-deriving the same hop selector
 * {@link clickDeepLocatorCandidate} uses rather than trusting a
 * caller-supplied `xpath=` string, so every deepLocator actuation seam stays
 * in lockstep. `DeepLocatorDelegate.fill()` resolves `Promise<void>` on
 * success and rejects on failure — same "rejects on failure, no boolean
 * return" contract as `clickDeepLocatorCandidate` — and a `fill()` that
 * exceeds `timeoutOptions.callTimeoutMs` rejects with a
 * `WatchdogTimeoutError` the same way. A framework-controlled (React/Angular)
 * input may not register a plain `fill()`; `fillHtml5DateTimeInput`
 * (`flow-runner.ts`) is the repo's existing native-setter + dispatch-events
 * escape hatch for that case, not this seam.
 */
export async function fillDeepLocatorCandidate(
  page: Page,
  frameSelector: string | null | undefined,
  innerSelector: string,
  index: number,
  value: string,
  timeoutOptions: DeepLocatorTimeoutOptions = {}
): Promise<void> {
  const callTimeoutMs = timeoutOptions.callTimeoutMs ?? DEFAULT_DEEP_LOCATOR_CALL_TIMEOUT_MS;
  const hopSelector = buildHopSelector(frameSelector, innerSelector);
  await withWatchdog(() => page.deepLocator(hopSelector).nth(index).fill(value), {
    timeoutMs: callTimeoutMs,
    label: `deepLocator fill() for ${hopSelector} nth=${index}`,
  });
}

/**
 * Selects `values` on the candidate at `index` inside the frame scoped by
 * `frameSelector`, re-deriving the same hop selector
 * {@link clickDeepLocatorCandidate} uses. `DeepLocatorDelegate.selectOption()`
 * resolves with the option values actually selected and rejects on failure —
 * the return value is passed through unchanged so a caller can verify the
 * selection landed, the same way Playwright's own `selectOption()` reports
 * back. A `selectOption()` that exceeds `timeoutOptions.callTimeoutMs`
 * rejects with a `WatchdogTimeoutError`, matching every other seam in this
 * module.
 */
export async function selectDeepLocatorCandidateOption(
  page: Page,
  frameSelector: string | null | undefined,
  innerSelector: string,
  index: number,
  values: string | string[],
  timeoutOptions: DeepLocatorTimeoutOptions = {}
): Promise<string[]> {
  const callTimeoutMs = timeoutOptions.callTimeoutMs ?? DEFAULT_DEEP_LOCATOR_CALL_TIMEOUT_MS;
  const hopSelector = buildHopSelector(frameSelector, innerSelector);
  return withWatchdog(() => page.deepLocator(hopSelector).nth(index).selectOption(values), {
    timeoutMs: callTimeoutMs,
    label: `deepLocator selectOption() for ${hopSelector} nth=${index}`,
  });
}
