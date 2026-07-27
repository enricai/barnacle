/**
 * Cross-origin frame resolver: the single seam that lets every downstream
 * helper (flow-runner primitives, guarded Stagehand calls) act on either the
 * main frame or a resolved cross-origin OOPIF without knowing which. Some
 * ATS integrations (e.g. UCHealth's Talemetry wizard) embed their entire
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
 * parseable — used to match a candidate `page.frames()` entry against the
 * `<iframe>` element's `src` attribute without requiring an exact URL match
 * (the iframe `src` and the frame's live `location.href` commonly differ by
 * path/query after the child navigates, e.g. an application UUID appended
 * post-load).
 */
function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/**
 * Attempts one resolution pass: reads the `<iframe>` element's `src` (not
 * `contentDocument`, which stays readable across the cross-origin boundary —
 * only same-origin script access to the child's document is blocked), then
 * looks for a `page.frames()` entry whose origin matches it. Returns `null`
 * rather than a target so the caller can distinguish "not yet attached, keep
 * polling" from a resolved target.
 *
 * The `src` attribute read can lose a same-tick race against the widget
 * script that constructs the `<iframe>`: some ATS integrations (e.g.
 * UCHealth's Talemetry wizard) assign `src` as a JS property immediately
 * before `appendChild`, so a poll can observe the element already in the
 * DOM with `src` still empty or not yet reflected to the attribute. Giving
 * up in that case would depend on same-tick attribute reflection that isn't
 * guaranteed. Instead, when the element is confirmed to be the matching
 * `<iframe>` but its `src` can't be read, fall back to matching by element
 * identity: if `page.frames()` has resolved exactly one candidate frame
 * beyond the main frame, that frame must be the one CDP attached to for
 * this iframe, so bind to it directly rather than degrading to the main
 * frame.
 *
 * Both `evaluate` calls (the top-level `<iframe>`-src probe and the
 * per-candidate `location.href` read) are bounded by `evaluateTimeoutMs`: a
 * wedged CDP call against a racy OOPIF must fail this one pass rather than
 * hanging it, since the top-level probe runs once *before*
 * `resolveFrameTarget`'s deadline loop even starts and would otherwise make
 * that deadline unreachable. A timed-out probe is treated as "no match, try
 * again" (same as a `false` `matched` result) so a poll that merely wedges
 * degrades to a retry rather than aborting resolution outright — a genuine
 * evaluate error (e.g. a caller passing an invalid selector) still
 * propagates unchanged, preserving the existing "rejects rather than
 * silently falling back" contract for real errors.
 */
async function tryResolveChildFrame(
  page: Page,
  frameSelector: string,
  evaluateTimeoutMs: number
): Promise<FrameTarget | null> {
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
    { timeoutMs: evaluateTimeoutMs, label: "frame-target: iframe src probe" }
  ).catch((err: unknown) => {
    if (err instanceof WatchdogTimeoutError) return { matched: false, src: null };
    throw err;
  });
  if (!matched) return null;

  const candidates = page.frames();
  const targetOrigin = iframeSrc ? originOf(iframeSrc) : null;
  if (!targetOrigin) {
    const [onlyCandidate] = candidates;
    return candidates.length === 1 && onlyCandidate
      ? childFrameTarget(page, onlyCandidate, frameSelector, { evaluateTimeoutMs })
      : null;
  }

  for (const candidate of candidates) {
    const candidateUrl = await withWatchdog(() => candidate.evaluate<string>("location.href"), {
      timeoutMs: evaluateTimeoutMs,
      label: "frame-target: candidate frame location probe",
    }).catch(() => null);
    if (candidateUrl && originOf(candidateUrl) === targetOrigin) {
      return childFrameTarget(page, candidate, frameSelector, { evaluateTimeoutMs });
    }
  }
  return null;
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
 * bounded by `evaluateTimeoutMs`, including the very first resolution
 * attempt made *before* the poll loop starts — without that bound, a single
 * wedged CDP call there hangs this function forever regardless of
 * `timeoutMs`, which is exactly what made the raised attach deadline
 * unenforceable.
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
  if (!frameSelector) return mainFrameTarget(page);

  const evaluateTimeoutMs = opts.evaluateTimeoutMs ?? config.scraper.frameEvaluateTimeoutMs;
  const resolved = await tryResolveChildFrame(page, frameSelector, evaluateTimeoutMs);
  if (resolved) return resolved;

  const timeoutMs = opts.timeoutMs ?? config.scraper.frameReadyTimeoutMs;
  const pollMs = opts.pollMs ?? FRAME_READY_POLL_MS;

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(pollMs);
    const polled = await tryResolveChildFrame(page, frameSelector, evaluateTimeoutMs);
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
