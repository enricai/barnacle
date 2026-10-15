/**
 * Centre-then-hit-test wrapper around Stagehand's trusted `Locator.click()`.
 * Stagehand scrolls with `DOM.scrollIntoViewIfNeeded` (which can leave the
 * target flush against a sticky header or fixed footer) and then clicks the
 * content-box centre without checking what is painted there, so an overlay
 * silently swallows the click. This helper first scrolls the target to the
 * viewport centre, confirms via `elementFromPoint` that the point resolves to
 * the target or a descendant, and only then delivers the trusted click.
 */

import { getLogger } from "@/lib/logging";
import type { FrameTarget } from "@/scraper/frame-target";

const logger = getLogger({ name: "scraper/trusted-click" });

/** Total centre + hit-test passes before an occluded target is reported as an error. */
export const DEFAULT_CENTRED_CLICK_ATTEMPTS = 3;

/** Outcome of one in-page centre + hit-test pass. */
export interface CentredHitTestResult {
  /** `"hit"` when the centre point resolves to the target; otherwise why not. */
  state: "hit" | "occluded" | "missing";
  /** Short description of the element covering the point, when occluded. */
  occluder?: string;
}

/**
 * Evaluates a function declaration source with the target element bound as
 * `this`. Injected so the deep-locator path can run it via
 * `Runtime.callFunctionOn` on `locator.resolveNode().objectId`.
 */
export type EvaluateOnElementFn = (functionDeclaration: string) => Promise<CentredHitTestResult>;

/** The minimal clickable surface both `Page.locator()` and `deepLocator().nth(i)` satisfy. */
export interface TrustedClickable {
  click(): Promise<void>;
}

export interface CentredTrustedClickOptions {
  /** Overrides {@link DEFAULT_CENTRED_CLICK_ATTEMPTS}. */
  attempts?: number;
  /** Names the target in logs and errors. */
  label?: string;
}

/**
 * In-page function (`this` is the target element): centres it, then hit-tests
 * the content-box centre, walking up through shadow-root hosts so a target
 * inside a shadow tree still counts as hit by its own descendants.
 */
export const CENTRE_AND_HIT_TEST_FN = `function () {
  const el = this;
  if (!el || !el.isConnected) return { state: "missing" };
  el.scrollIntoView({ block: "center", inline: "center" });
  const rect = el.getBoundingClientRect();
  const cs = getComputedStyle(el);
  const px = (v) => parseFloat(v) || 0;
  const left = rect.left + px(cs.borderLeftWidth) + px(cs.paddingLeft);
  const right = rect.right - px(cs.borderRightWidth) - px(cs.paddingRight);
  const top = rect.top + px(cs.borderTopWidth) + px(cs.paddingTop);
  const bottom = rect.bottom - px(cs.borderBottomWidth) - px(cs.paddingBottom);
  const x = (left + right) / 2;
  const y = (top + bottom) / 2;
  let hit = el.getRootNode().elementFromPoint
    ? el.getRootNode().elementFromPoint(x, y)
    : document.elementFromPoint(x, y);
  for (let node = hit; node; ) {
    if (node === el) return { state: "hit" };
    node = node.parentNode && node.parentNode.host ? node.parentNode.host : node.parentNode;
  }
  const tag = hit && hit.tagName ? hit.tagName.toLowerCase() : "none";
  const id = hit && hit.id ? "#" + hit.id : "";
  return { state: "occluded", occluder: tag + id };
}`;

/**
 * Thrown by {@link centreAndHitTest} when no pass lands on the target. `state`
 * lets callers tell an occluder (never click) from a target the evaluating
 * document cannot see (Stagehand may still resolve it across a frame or shadow
 * boundary).
 */
export class CentredClickError extends Error {
  constructor(
    message: string,
    readonly state: "occluded" | "missing"
  ) {
    super(message);
    this.name = "CentredClickError";
  }
}

/**
 * Centre + hit-test until the click point lands on the target, without
 * clicking. Lets callers whose click is delivered elsewhere (e.g. a Stagehand
 * `Locator.click()` that re-scrolls and clicks the content-box centre) still
 * guarantee a clear click point first. Retries re-centre because a lazy-loaded
 * layout shift or a sticky bar can move between passes.
 *
 * @throws when the target is missing or still occluded after all attempts.
 */
export async function centreAndHitTest(
  evaluateOnElement: EvaluateOnElementFn,
  opts: CentredTrustedClickOptions = {}
): Promise<void> {
  const attempts = Math.max(1, opts.attempts ?? DEFAULT_CENTRED_CLICK_ATTEMPTS);
  const label = opts.label ?? "target";
  let last: CentredHitTestResult = { state: "missing" };
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const result = await evaluateOnElement(CENTRE_AND_HIT_TEST_FN);
    last = result?.state === "hit" || result?.state === "occluded" ? result : { state: "missing" };
    if (last.state === "hit") return;
    logger.warn(
      `click point for ${label} not on target (${last.state}${last.occluder ? `, covered by ${last.occluder}` : ""}), attempt: ${attempt}/${attempts}`
    );
  }
  throw new CentredClickError(
    last.state === "missing"
      ? `centred click: ${label} is not in the document`
      : `centred click: ${label} is occluded by ${last.occluder ?? "another element"} after ${attempts} attempts`,
    last.state === "missing" ? "missing" : "occluded"
  );
}

/**
 * Core loop shared by every entry point: centre + hit-test until the point
 * lands on the target, then click exactly once.
 *
 * @throws when the target is missing or still occluded after all attempts —
 * never clicks an overlay.
 */
export async function clickAfterCentredHitTest(
  clickable: TrustedClickable,
  evaluateOnElement: EvaluateOnElementFn,
  opts: CentredTrustedClickOptions = {}
): Promise<void> {
  await centreAndHitTest(evaluateOnElement, opts);
  await clickable.click();
}

/**
 * Builds the in-frame expression resolving `selector` (css, or `xpath=` /
 * bare xpath beginning with `/` or `(`) and applying the centring function.
 */
function buildSelectorExpression(selector: string): string {
  const stripped = selector.startsWith("xpath=") ? selector.slice("xpath=".length) : selector;
  const isXpath = stripped.startsWith("/") || stripped.startsWith("(");
  const lookup = isXpath
    ? `document.evaluate(${JSON.stringify(stripped)}, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue`
    : `document.querySelector(${JSON.stringify(selector)})`;
  return `(() => {
    const el = ${lookup};
    if (!el) return { state: "missing" };
    return (${CENTRE_AND_HIT_TEST_FN}).call(el);
  })()`;
}

/**
 * Resolves the handle a trusted click is delivered on. A locator that clicks
 * itself is used directly; one that only exposes `first()` (the shape every
 * trusted click used before the centring helper existed) is narrowed to its
 * first match.
 */
export function firstMatchClickable(locator: ReturnType<FrameTarget["locator"]>): TrustedClickable {
  return typeof locator.click === "function" ? locator : locator.first();
}

/**
 * Trusted-clicks `selector` inside a main-frame or child-frame `FrameTarget`
 * after centring it and confirming the click point hits it.
 */
export async function clickCentredTrusted(
  target: FrameTarget,
  selector: string,
  opts: CentredTrustedClickOptions = {}
): Promise<void> {
  const expression = buildSelectorExpression(selector);
  await clickAfterCentredHitTest(
    firstMatchClickable(target.locator(selector)),
    () => target.evaluate<CentredHitTestResult>(expression),
    { label: selector, ...opts }
  );
}

/**
 * Centres `selector` and confirms its click point is unobstructed without
 * clicking, so a subsequent Stagehand-issued click lands on the target.
 */
export async function centreSelectorForClick(
  target: FrameTarget,
  selector: string,
  opts: CentredTrustedClickOptions = {}
): Promise<void> {
  const expression = buildSelectorExpression(selector);
  await centreAndHitTest(() => target.evaluate<CentredHitTestResult>(expression), {
    label: selector,
    ...opts,
  });
}
