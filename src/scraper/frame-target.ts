/**
 * Cross-origin frame resolver: the single seam that lets every downstream
 * helper (flow-runner primitives, guarded Stagehand calls) act on either the
 * main frame or a resolved cross-origin OOPIF without knowing which. Some
 * ATS integrations (e.g. a cross-origin OOPIF apply wizard) embed their entire
 * application form inside a cross-origin `<iframe>` rather than navigating
 * the top window to it, and `document`-rooted helpers (`page.evaluate`,
 * `page.locator`) cannot reach across that boundary — `contentDocument` on a
 * cross-origin iframe element is `null` from page script's perspective.
 * `resolveFrameTarget` finds the child `Frame` Stagehand's CDP layer already
 * attached to and wraps it in a uniform `FrameTarget` surface.
 */

import type { Page } from "@browserbasehq/stagehand";

import { config } from "@/config";
import { getLogger } from "@/lib/logging";
import { WatchdogTimeoutError, withWatchdog } from "@/scraper/watchdog";

const logger = getLogger({ name: "scraper/frame-target" });

/** The frame handle type `Page.frames()` returns, without a deep import into Stagehand's understudy internals. */
type StagehandFrame = ReturnType<Page["frames"]>[number];

/**
 * Uniform evaluate/locator/url/title surface bound to either the main frame
 * (`frame: null`) or a resolved cross-origin child frame. `frameSelector` is
 * the CSS selector of the scoped frame (or `null` for main), carried so
 * callers can pass it straight through to `ObserveOptions.selector` /
 * `ExtractOptions.selector` and scope Stagehand's own observe/extract calls
 * to the same frame this target evaluates and locates against.
 */
export interface FrameTarget {
  /** The resolved child frame, or `null` when this target is bound to the main frame. */
  readonly frame: StagehandFrame | null;
  /** CSS selector for the Stagehand scope hint (`ObserveOptions.selector` / `ExtractOptions.selector`), or `null` for the main frame. */
  readonly frameSelector: string | null;
  /**
   * The frame selector a caller originally asked `resolveFrameTarget` to bind
   * to, kept even when resolution fails and this target falls back to the
   * main frame (`frameSelector: null`). `frameSelector` stays `null` on a
   * failed resolution because it un-scopes `ObserveOptions.selector` via
   * `stagehand-guard`'s `frameScopedOptions` — that contract must not change.
   * This field is the separate, additive signal a caller can use to notice
   * "the frame I asked for didn't attach" and retry resolution later, e.g.
   * right before a deepLocator candidate probe. `undefined` on targets built
   * outside `resolveFrameTarget` (hand-constructed test fakes, older call
   * sites) rather than a required field, so it never forces every existing
   * `FrameTarget` literal to be updated.
   */
  readonly declaredFrameSelector?: string | null;
  /** Evaluate a function or expression against the resolved frame (or the main frame when unresolved). */
  evaluate<R = unknown, Arg = unknown>(
    pageFunctionOrExpression: string | ((arg: Arg) => R | Promise<R>),
    arg?: Arg
  ): Promise<R>;
  /** Build a Locator scoped to the resolved frame (or the main frame when unresolved). */
  locator(selector: string): ReturnType<Page["locator"]>;
  /** Current URL of the resolved frame (or the main frame when unresolved). */
  url(): Promise<string>;
  /** Current document title. Cross-origin child frames have no accessible `document.title` distinct from the top document via CDP `Page.title`, so this always reads the top document's title. */
  title(): Promise<string>;
}

/**
 * Builds the main-frame `FrameTarget`: every method delegates to `Page`,
 * matching today's behavior for every site whose ATS form never leaves the
 * top window. `evaluate`/`title` are bounded by a watchdog — a wedged CDP
 * call (e.g. a racy Browserbase session) must fail the caller's await
 * instead of hanging it, since `evaluate`/`url` are the first awaits inside
 * `flow-runner.ts`'s per-attempt snapshot, ahead of any attempt log.
 * Exported so call sites that have not yet resolved a `FrameTarget` from
 * `deps.frameSelector` can still pass a target-shaped value to helpers that
 * now require one.
 */
export function mainFrameTarget(
  page: Page,
  opts: { declaredFrameSelector?: string | null; evaluateTimeoutMs?: number } = {}
): FrameTarget {
  const evaluateTimeoutMs = opts.evaluateTimeoutMs ?? config.scraper.frameEvaluateTimeoutMs;
  return {
    frame: null,
    frameSelector: null,
    declaredFrameSelector: opts.declaredFrameSelector ?? null,
    evaluate: (pageFunctionOrExpression, arg) =>
      withWatchdog(() => page.evaluate(pageFunctionOrExpression, arg), {
        timeoutMs: evaluateTimeoutMs,
        label: "frame-target: main frame evaluate",
      }),
    locator: (selector) => page.locator(selector),
    url: () => Promise.resolve(page.url()),
    title: () =>
      withWatchdog(() => page.title(), {
        timeoutMs: evaluateTimeoutMs,
        label: "frame-target: main frame title",
      }),
  };
}

/**
 * Builds a child-frame `FrameTarget`: `evaluate`/`locator` delegate to the
 * resolved `Frame` (reaching across the cross-origin boundary via its own
 * CDP session), while `url`/`title` fall back to the frame's own
 * `location.href` and the top document's title respectively — `Frame` has
 * no `title()` of its own. `evaluate`/`url`/`title` are bounded by the same
 * watchdog as `mainFrameTarget` (`locator` stays unwrapped — it's
 * synchronous, building a `Locator` handle rather than making a CDP call).
 */
function childFrameTarget(
  page: Page,
  frame: StagehandFrame,
  frameSelector: string,
  opts: { evaluateTimeoutMs?: number } = {}
): FrameTarget {
  const evaluateTimeoutMs = opts.evaluateTimeoutMs ?? config.scraper.frameEvaluateTimeoutMs;
  const evaluateOnFrame = <R = unknown, Arg = unknown>(
    pageFunctionOrExpression: string | ((arg: Arg) => R | Promise<R>),
    arg?: Arg
  ): Promise<R> =>
    withWatchdog(() => frame.evaluate<R, Arg>(pageFunctionOrExpression, arg), {
      timeoutMs: evaluateTimeoutMs,
      label: "frame-target: child frame evaluate",
    });
  return {
    frame,
    frameSelector,
    declaredFrameSelector: frameSelector,
    evaluate: evaluateOnFrame,
    locator: (selector) => frame.locator(selector),
    url: () => evaluateOnFrame<string>("location.href"),
    title: () =>
      withWatchdog(() => page.title(), {
        timeoutMs: evaluateTimeoutMs,
        label: "frame-target: child frame title",
      }),
  };
}

/**
 * Reads the origin (scheme + host) off a URL string, or `null` if it isn't
 * parseable — the coarsest match tier {@link scoreFrameUrlMatch} falls back to
 * when the iframe `src` and a candidate frame's live `location.href` share no
 * path (e.g. an application UUID the child appended post-load).
 */
function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/**
 * Strips the query/hash off a URL so a candidate frame's `location.href` can be
 * compared to the `<iframe>` `src` by scheme+host+path alone — the path (e.g.
 * `/application/<uuid>`) is what distinguishes the real wizard frame from an
 * empty same-origin shell frame the page also hosts.
 */
function urlWithoutQuery(url: string): string {
  const q = url.indexOf("?");
  const h = url.indexOf("#");
  const cut = [q, h].filter((i) => i >= 0).sort((a, b) => a - b)[0];
  return cut === undefined ? url : url.slice(0, cut);
}

/**
 * Ranks how specifically a candidate frame's `location.href` matches the
 * `<iframe>` element's `src`, so a page with more than one same-origin child
 * frame binds the frame the target `<iframe>` actually hosts rather than the
 * first origin match in `page.frames()` order (a whole class of "bound the
 * empty shell frame" bugs — the iframe `src` path uniquely identifies the real
 * frame, but origin alone does not). Higher is a stronger match; `0` means no
 * match at all (not even origin):
 *   3 — exact URL (query/hash ignored): the src path IS the frame's URL.
 *   2 — the frame's path extends the src path (the child navigated deeper).
 *   1 — same origin only (the post-load-drift fallback `originOf` documents).
 *   0 — different origin / unparseable.
 */
function scoreFrameUrlMatch(candidateUrl: string, iframeSrc: string): number {
  const candOrigin = originOf(candidateUrl);
  const srcOrigin = originOf(iframeSrc);
  if (!candOrigin || !srcOrigin || candOrigin !== srcOrigin) return 0;
  const candPath = urlWithoutQuery(candidateUrl);
  const srcPath = urlWithoutQuery(iframeSrc);
  if (candPath === srcPath) return 3;
  // A path extension must continue at a segment boundary ("/app" extends
  // "/app/2" but not "/apple"), so an unrelated sibling path scores origin-only.
  if (extendsAtSegmentBoundary(candPath, srcPath) || extendsAtSegmentBoundary(srcPath, candPath)) {
    return 2;
  }
  return 1;
}

/** True when `longer` is `shorter` continued at a path-segment boundary (a trailing "/…"), not merely a string prefix. */
function extendsAtSegmentBoundary(longer: string, shorter: string): boolean {
  return (
    longer.length > shorter.length && longer.startsWith(shorter) && longer[shorter.length] === "/"
  );
}

/**
 * Attempts one resolution pass: reads the `<iframe>` element's `src` (not
 * `contentDocument`, which stays readable across the cross-origin boundary —
 * only same-origin script access to the child's document is blocked), then
 * binds the `page.frames()` child frame that matches it most specifically.
 * Returns `null` rather than a target so the caller can distinguish "not yet
 * attached, keep polling" from a resolved target.
 *
 * Match specificity matters because a page commonly hosts more than one
 * child frame on the *same origin* as the target `<iframe>` — an empty shell
 * frame plus the real populated wizard, tracking/telemetry sub-frames, etc.
 * Binding by origin alone (the first origin match in `page.frames()` order)
 * intermittently binds the empty shell, after which every downstream
 * enumerate/click/fill silently operates on an empty document. The iframe
 * `src` (e.g. `/application/<uuid>`) uniquely identifies the real frame, so
 * candidates are ranked by {@link scoreFrameUrlMatch} (exact URL > path
 * extension > origin-only) and, among equally-ranked candidates, one with a
 * *non-empty* document is preferred so an empty shell can never outrank the
 * populated wizard. The main frame is excluded from the candidate set up front
 * (`frameId !== page.mainFrameId()`), since the target is always a child.
 *
 * The `src` attribute read can lose a same-tick race against the widget
 * script that constructs the `<iframe>`: some ATS integrations (e.g.
 * a cross-origin OOPIF apply wizard) assign `src` as a JS property immediately
 * before `appendChild`, so a poll can observe the element already in the
 * DOM with `src` still empty or not yet reflected to the attribute. Giving
 * up in that case would depend on same-tick attribute reflection that isn't
 * guaranteed. Instead, when the element is confirmed to be the matching
 * `<iframe>` but its `src` can't be read, fall back to matching by element
 * identity: if exactly one child frame (excluding the main frame) is
 * attached, that frame must be the one CDP attached to for this iframe, so
 * bind to it directly rather than degrading to the main frame.
 *
 * Every `evaluate` call — the top-level `<iframe>`-src probe, each candidate's
 * `location.href` read, and the non-empty-document tiebreak (only run when two
 * or more candidates tie on URL specificity) — is bounded by `evaluateTimeoutMs`,
 * further clamped to whatever remains of `deadline` — `resolveFrameTarget`'s
 * total attach budget — at the moment each probe starts: a wedged CDP call
 * against a racy OOPIF must fail this one pass rather than hanging it, and
 * the clamp keeps that true even for the *sum* of every probe a single pass
 * makes, since the top-level probe runs once *before* `resolveFrameTarget`'s
 * poll loop even starts (making an unclamped deadline unreachable) and a
 * page with several candidate frames would otherwise pay a per-frame multiple
 * of `evaluateTimeoutMs` in one pass regardless of `deadline`.
 * The candidate loop always probes its first candidate — paralleling the
 * top-level probe's "runs once regardless of budget" guarantee, since a
 * `timeoutMs: 0` re-resolution (`flow-runner.ts`'s `reresolveFrameTargetIfLost`)
 * must still be able to pick up a frame that has already attached — but
 * breaks before any further candidate once no budget remains, rather than
 * still issuing a zero-budget probe per remaining candidate. A timed-out
 * probe is treated as "no match, try again" (same as a `false` `matched`
 * result) so a poll that merely wedges degrades to a retry rather than
 * aborting resolution outright — a genuine evaluate error (e.g. a caller
 * passing an invalid selector) still propagates unchanged, preserving the
 * existing "rejects rather than silently falling back" contract for real
 * errors.
 */
async function tryResolveChildFrame(
  page: Page,
  frameSelector: string,
  evaluateTimeoutMs: number,
  deadline: number
): Promise<FrameTarget | null> {
  const remainingBudgetMs = (): number => Math.max(0, deadline - Date.now());

  const iframeSrcExpr = `(() => {
    const el = document.querySelector(${JSON.stringify(frameSelector)});
    if (!el || el.tagName !== "IFRAME") return { matched: false, src: null };
    return { matched: true, src: el.getAttribute("src") };
  })()`;
  const { matched, src: iframeSrc } = await withWatchdog(
    () =>
      page.evaluate<{
        matched: boolean;
        src: string | null;
      }>(iframeSrcExpr),
    {
      timeoutMs: Math.min(evaluateTimeoutMs, remainingBudgetMs()),
      label: "frame-target: iframe src probe",
    }
  ).catch((err: unknown) => {
    if (err instanceof WatchdogTimeoutError) return { matched: false, src: null };
    throw err;
  });
  if (!matched) return null;

  const mainFrameId = page.mainFrameId();
  const candidates = page.frames().filter((frame) => frame.frameId !== mainFrameId);

  // The iframe `src` can't be resolved to an origin — it's empty (a same-tick
  // race before the attribute reflects) or a relative/unparseable value. Fall
  // back to element identity: exactly one attached child frame must be this
  // iframe's, so bind it rather than degrading to the main frame.
  if (!iframeSrc || originOf(iframeSrc) === null) {
    const [onlyCandidate] = candidates;
    return candidates.length === 1 && onlyCandidate
      ? childFrameTarget(page, onlyCandidate, frameSelector, { evaluateTimeoutMs })
      : null;
  }

  // Score every child candidate by how specifically its live URL matches the
  // iframe `src` (one `location.href` probe each), keeping the best-scoring
  // group. The first candidate is always probed (a `timeoutMs: 0` re-resolution
  // must still pick up an already-attached frame); further candidates stop once
  // the budget is exhausted. Every candidate in budget is scored (no early
  // break): two frames can share the exact iframe-src URL — an empty shell and
  // the populated wizard — and both must be collected so the non-empty tiebreak
  // below can pick the wizard.
  const topByScore: { candidate: StagehandFrame; score: number }[] = [];
  for (const [index, candidate] of candidates.entries()) {
    if (index > 0 && remainingBudgetMs() <= 0) break;
    const candidateUrl = await withWatchdog(() => candidate.evaluate<string>("location.href"), {
      timeoutMs: Math.min(evaluateTimeoutMs, remainingBudgetMs()),
      label: "frame-target: candidate frame location probe",
    }).catch(() => null);
    if (!candidateUrl) continue;
    const score = scoreFrameUrlMatch(candidateUrl, iframeSrc);
    if (score === 0) continue;
    const bestScore = topByScore[0]?.score ?? 0;
    if (score > bestScore) {
      topByScore.length = 0;
      topByScore.push({ candidate, score });
    } else if (score === bestScore) {
      topByScore.push({ candidate, score });
    }
  }

  const [first, ...rest] = topByScore;
  if (!first) return null;
  // Single best-scoring candidate — no tie to break, so bind it without paying
  // the extra non-empty probe (the common single-frame case).
  if (rest.length === 0) {
    return childFrameTarget(page, first.candidate, frameSelector, { evaluateTimeoutMs });
  }
  // Multiple candidates tie on score (e.g. an empty same-origin shell and the
  // populated wizard share the iframe-src URL). Prefer a non-empty document so
  // the shell never wins; the probe is best-effort — a candidate whose probe
  // fails is treated as non-empty rather than demoted, and the first tied
  // candidate is the fallback when none reports non-empty.
  for (const { candidate } of topByScore) {
    if (remainingBudgetMs() <= 0) break;
    const nonEmpty = await withWatchdog(
      () => candidate.evaluate<boolean>("!!(document.body && document.body.childElementCount > 0)"),
      {
        timeoutMs: Math.min(evaluateTimeoutMs, remainingBudgetMs()),
        label: "frame-target: candidate frame non-empty probe",
      }
    ).catch(() => true);
    if (nonEmpty) return childFrameTarget(page, candidate, frameSelector, { evaluateTimeoutMs });
  }
  return childFrameTarget(page, first.candidate, frameSelector, { evaluateTimeoutMs });
}

/**
 * Single non-polling presence probe for a frame that may have already
 * attached — the seam callers should use instead of hand-rolling
 * `resolveFrameTarget(page, frameSelector, { timeoutMs: 0 })` for an
 * "is it already there?" check (`deep-locator-actuate.ts`,
 * `deep-locator-candidates.ts`, `flow-runner.ts`'s
 * `reresolveFrameTargetIfLost`). That zero-budget pattern sets
 * `tryResolveChildFrame`'s deadline to `Date.now() + 0`, so every probe
 * clamps to `Math.min(evaluateTimeoutMs, remainingBudgetMs()) === 0` — a
 * `setTimeout(reject, 0)` macrotask that always wins the race against a
 * genuinely awaited CDP round-trip, so the probe can never observe an
 * already-attached frame outside of a same-tick-resolving test fake. This
 * probe's deadline instead starts `probeFloorMs` (config-backed via
 * `config.scraper.framePresenceProbeFloorMs`) in the future, giving each
 * `withWatchdog` call a real budget a CDP round-trip can land within.
 *
 * Still never polls: exactly one top-level iframe-src probe, plus — per
 * `tryResolveChildFrame`'s existing `index > 0 && remainingBudgetMs() <= 0`
 * bound — at most one further candidate probe, so a single call costs at
 * most ~2x `probeFloorMs` regardless of how many `page.frames()` candidates
 * exist. Returns `null` (never a main-frame fallback) when nothing attaches
 * within the floor, so a caller can tell "not present yet" apart from a
 * resolved target and keep its own fallback behavior.
 */
export async function probeAttachedFrameTarget(
  page: Page,
  frameSelector: string,
  opts: { evaluateTimeoutMs?: number; probeFloorMs?: number } = {}
): Promise<FrameTarget | null> {
  const evaluateTimeoutMs = opts.evaluateTimeoutMs ?? config.scraper.frameEvaluateTimeoutMs;
  const probeFloorMs = opts.probeFloorMs ?? config.scraper.framePresenceProbeFloorMs;
  return tryResolveChildFrame(page, frameSelector, evaluateTimeoutMs, Date.now() + probeFloorMs);
}

/**
 * Resolves the `FrameTarget` for `frameSelector` against `page`, polling for
 * up to `timeoutMs` (at `pollMs` intervals) before falling back to the
 * main-frame target rather than throwing:
 *
 * 1. `frameSelector` is `null`/`undefined` → main-frame target (today's
 *    behavior, unchanged) — zero polling, zero delay.
 * 2. Each poll: no element in the main document matches `frameSelector`, or
 *    it isn't an `<iframe>`, or its `src` can't be read and more than one
 *    `page.frames()` candidate exists (identity match is ambiguous), or no
 *    `page.frames()` entry has a matching origin yet → try again after
 *    `pollMs`.
 * 3. A poll finds a matching frame → a child-frame target bound to it,
 *    however many polls it took (an iframe created mid-flow by an earlier
 *    step, e.g. after a click reveals it, resolves as soon as Stagehand's
 *    CDP layer attaches to it instead of only when present at the first
 *    poll).
 * 4. Still unresolved once the deadline passes → main-frame target carrying
 *    `declaredFrameSelector` (so a caller can notice the failure and retry
 *    resolution later), with a `warn` naming the selector so a silent
 *    revert-to-main-frame is diagnosable from the log instead of invisible.
 *
 * Every `page`/`Frame` `evaluate` call this function (transitively) makes is
 * bounded by `evaluateTimeoutMs`, further clamped to whatever remains of the
 * total attach `deadline` at the moment each probe starts — including the
 * very first resolution attempt made *before* the poll loop starts. Without
 * that clamp, a single wedged CDP call there hangs this function for up to
 * `evaluateTimeoutMs`, and a page with several `page.frames()` candidates
 * multiplies that by each candidate probed in the same pass, which is
 * exactly what made the declared attach deadline (`timeoutMs`) unenforceable
 * whenever `evaluateTimeoutMs` exceeded it.
 *
 * `opts` overrides the timing for tests; production call sites default from
 * `config.scraper.frameReadyTimeoutMs` / `frameEvaluateTimeoutMs` (poll
 * cadence stays the fixed `FRAME_READY_POLL_MS`, cheap enough not to need
 * tuning).
 */
export async function resolveFrameTarget(
  page: Page,
  frameSelector?: string | null,
  opts: { timeoutMs?: number; pollMs?: number; evaluateTimeoutMs?: number } = {}
): Promise<FrameTarget> {
  const evaluateTimeoutMs = opts.evaluateTimeoutMs ?? config.scraper.frameEvaluateTimeoutMs;
  if (!frameSelector) return mainFrameTarget(page, { evaluateTimeoutMs });

  const timeoutMs = opts.timeoutMs ?? config.scraper.frameReadyTimeoutMs;
  const pollMs = opts.pollMs ?? FRAME_READY_POLL_MS;
  const deadline = Date.now() + timeoutMs;

  const resolved = await tryResolveChildFrame(page, frameSelector, evaluateTimeoutMs, deadline);
  if (resolved) return resolved;

  while (Date.now() < deadline) {
    await sleep(pollMs);
    const polled = await tryResolveChildFrame(page, frameSelector, evaluateTimeoutMs, deadline);
    if (polled) return polled;
  }

  logger.warn(
    `frame ${frameSelector} did not attach within ${timeoutMs}ms — falling back to main frame`
  );
  return mainFrameTarget(page, { declaredFrameSelector: frameSelector, evaluateTimeoutMs });
}

const HOP_SEPARATOR = " >> ";

/**
 * Composes a Stagehand hop-notation scope string from a frame selector and an
 * inner selector, for callers building `ObserveOptions.selector` /
 * `ExtractOptions.selector` values — kept separate from `FrameTarget` itself
 * so `resolveFrameTarget` keeps receiving only the bare iframe-id hop (the
 * contract `frame-resolve.test.ts` pins) rather than a pre-composed string.
 */
export function buildHopSelector(
  frameSelector: string | null | undefined,
  innerSelector: string
): string {
  if (!frameSelector) return innerSelector;
  const trimmedFrameSelector = frameSelector.trimEnd();
  if (trimmedFrameSelector.endsWith(">>")) {
    return `${trimmedFrameSelector} ${innerSelector.trimStart()}`;
  }
  return `${trimmedFrameSelector}${HOP_SEPARATOR}${innerSelector.trimStart()}`;
}

/** Poll cadence shared by `resolveFrameTarget` and `waitForChildFrameReady` — cheap enough not to need per-call tuning. */
const FRAME_READY_POLL_MS = 100;

/** Shared delay helper — `FrameTarget` has no `waitForTimeout` since it isn't frame-scoped. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Blocks until a resolved child frame has a live document (`document.readyState`
 * is `"interactive"` or `"complete"`), so callers do not observe/act against a
 * frame that CDP has attached to but that has not yet navigated past `about:blank`
 * — the state right after `Target.setAutoAttach` fires and before the OOPIF's own
 * navigation lands. Best-effort like `waitForSpaReady`: never throws, just resolves
 * once ready or once `timeoutMs` elapses, so a frame that never becomes ready
 * degrades to "proceed anyway" rather than hanging the flow.
 *
 * Each `document.readyState` probe is itself bounded by `evaluateTimeoutMs` and
 * treated as not-ready on timeout (same as a rejected `evaluate`) — otherwise a
 * single wedged CDP call inside one poll would block past `timeoutMs`, defeating
 * the outer deadline this function exists to enforce.
 *
 * `opts` overrides the timing for tests; production call sites default from
 * `config.scraper.frameDocumentReadyTimeoutMs` / `frameEvaluateTimeoutMs` — kept
 * separate from `resolveFrameTarget`'s (longer) attach budget since this wait
 * settles in well under a second once the frame has attached.
 */
export async function waitForChildFrameReady(
  target: FrameTarget,
  opts: { timeoutMs?: number; pollMs?: number; evaluateTimeoutMs?: number } = {}
): Promise<void> {
  if (!target.frame) return;

  const timeoutMs = opts.timeoutMs ?? config.scraper.frameDocumentReadyTimeoutMs;
  const pollMs = opts.pollMs ?? FRAME_READY_POLL_MS;
  const evaluateTimeoutMs = opts.evaluateTimeoutMs ?? config.scraper.frameEvaluateTimeoutMs;

  const isReady = async (): Promise<boolean> => {
    const readyState = await withWatchdog(() => target.evaluate<string>("document.readyState"), {
      timeoutMs: evaluateTimeoutMs,
      label: "frame-target: document.readyState probe",
    }).catch(() => null);
    return readyState === "interactive" || readyState === "complete";
  };

  if (await isReady()) return;

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(pollMs);
    if (await isReady()) return;
  }
  logger.warn(
    `child frame ${target.frameSelector ?? "(unresolved)"} still not ready after ${timeoutMs}ms — proceeding anyway`
  );
}
