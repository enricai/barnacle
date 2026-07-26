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
import { buildHopSelector } from "@/scraper/frame-target";

const logger = getLogger({ name: "scraper/deep-locator-candidates" });

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
  /** Accessible text read via the delegate's `textContent()`. */
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
 * Enumerates every element `page.deepLocator()` matches inside the frame
 * scoped by `frameSelector`, ranked by relevance to `instruction` (highest
 * first, ties preserving original delegate/DOM order). Composes the hop
 * scope via `buildHopSelector` (owned by `frame-target.ts`) rather than
 * string-concatenating `>>` itself, so hop notation stays defined in exactly
 * one place. Never throws: a `count()`/`nth()`/`textContent()` failure
 * (detached frame, navigated-away element) degrades to `[]` so a caller
 * cascading through candidate sources can move on to the next technique
 * instead of crashing the step.
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
  instruction?: string | null
): Promise<DeepLocatorCandidate[]> {
  const hopSelector = buildHopSelector(frameSelector, innerSelector);
  const delegate = page.deepLocator(hopSelector);

  const count = await delegate.count().catch((err: unknown) => {
    logger.warn(`deepLocator count() threw for ${hopSelector}: ${toErrorMessage(err)}`);
    return 0;
  });
  if (count === 0) return [];

  const candidates: DeepLocatorCandidate[] = [];
  for (let index = 0; index < count; index++) {
    const accessibleText = await delegate
      .nth(index)
      .textContent()
      .catch(() => "");
    candidates.push({
      index,
      selector: candidateSelector(hopSelector, index),
      accessibleText: accessibleText.trim(),
    });
  }
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
 */
export async function clickDeepLocatorCandidate(
  page: Page,
  frameSelector: string | null | undefined,
  innerSelector: string,
  index: number
): Promise<void> {
  const hopSelector = buildHopSelector(frameSelector, innerSelector);
  await page.deepLocator(hopSelector).nth(index).click();
}
