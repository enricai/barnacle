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

import { getLogger } from "@/lib/logging";

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
 * Builds the main-frame `FrameTarget`: every method delegates straight to
 * `Page`, matching today's behavior for every site whose ATS form never
 * leaves the top window. Exported so call sites that have not yet resolved
 * a `FrameTarget` from `deps.frameSelector` can still pass a target-shaped
 * value to helpers that now require one.
 */
export function mainFrameTarget(page: Page): FrameTarget {
  return {
    frame: null,
    frameSelector: null,
    evaluate: (pageFunctionOrExpression, arg) => page.evaluate(pageFunctionOrExpression, arg),
    locator: (selector) => page.locator(selector),
    url: () => Promise.resolve(page.url()),
    title: () => page.title(),
  };
}

/**
 * Builds a child-frame `FrameTarget`: `evaluate`/`locator` delegate to the
 * resolved `Frame` (reaching across the cross-origin boundary via its own
 * CDP session), while `url`/`title` fall back to the frame's own
 * `location.href` and the top document's title respectively — `Frame` has
 * no `title()` of its own.
 */
function childFrameTarget(page: Page, frame: StagehandFrame, frameSelector: string): FrameTarget {
  return {
    frame,
    frameSelector,
    evaluate: (pageFunctionOrExpression, arg) => frame.evaluate(pageFunctionOrExpression, arg),
    locator: (selector) => frame.locator(selector),
    url: () => frame.evaluate<string>("location.href"),
    title: () => page.title(),
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
 * Resolves the `FrameTarget` for `frameSelector` against `page`, falling
 * back to the main-frame target whenever resolution can't confidently
 * succeed rather than throwing:
 *
 * 1. `frameSelector` is `null`/`undefined` → main-frame target (today's
 *    behavior, unchanged).
 * 2. No element in the main document matches `frameSelector`, or it isn't
 *    an `<iframe>`/has no `src` → main-frame target.
 * 3. No frame in `page.frames()` has an origin matching the `<iframe>`
 *    element's `src` → main-frame target.
 * 4. Otherwise → a child-frame target bound to the first matching frame.
 *
 * Step 2 reads the `src` attribute (not `contentDocument`) via `page.evaluate`
 * on the main frame, which stays readable across the cross-origin boundary —
 * only same-origin script access to the child's document is blocked.
 */
export async function resolveFrameTarget(
  page: Page,
  frameSelector?: string | null
): Promise<FrameTarget> {
  if (!frameSelector) return mainFrameTarget(page);

  const iframeSrcExpr = `(() => {
    const el = document.querySelector(${JSON.stringify(frameSelector)});
    if (!el || el.tagName !== "IFRAME") return null;
    return el.getAttribute("src");
  })()`;
  const iframeSrc = await page.evaluate<string | null>(iframeSrcExpr);
  if (!iframeSrc) return mainFrameTarget(page);

  const targetOrigin = originOf(iframeSrc);
  if (!targetOrigin) return mainFrameTarget(page);

  const candidates = page.frames();
  for (const candidate of candidates) {
    const candidateUrl = await candidate.evaluate<string>("location.href").catch(() => null);
    if (candidateUrl && originOf(candidateUrl) === targetOrigin) {
      return childFrameTarget(page, candidate, frameSelector);
    }
  }
  return mainFrameTarget(page);
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

/** Readiness-wait defaults — cheap poll, short timeout: an attached-but-not-yet-navigated child frame should settle in well under a second. */
const FRAME_READY_TIMEOUT_MS = 5_000;
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
 */
export async function waitForChildFrameReady(
  target: FrameTarget,
  opts: { timeoutMs?: number; pollMs?: number } = {}
): Promise<void> {
  if (!target.frame) return;

  const timeoutMs = opts.timeoutMs ?? FRAME_READY_TIMEOUT_MS;
  const pollMs = opts.pollMs ?? FRAME_READY_POLL_MS;

  const isReady = async (): Promise<boolean> => {
    const readyState = await target.evaluate<string>("document.readyState").catch(() => null);
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
