export interface SettlePage {
  waitForTimeout(ms: number): Promise<void>;
}

export interface SettleCounter {
  n: number;
}

export interface PageQuiescence {
  pending: number;
  mutations: number;
}

/**
 * Folds the whole-page text digest into the signature settle compares, so a
 * re-render that keeps the length and the 200-char head still counts as movement.
 */
export function settleTextKey(visibleTextSignature: string, visibleTextDigest?: string): string {
  return visibleTextDigest ? `${visibleTextSignature}#${visibleTextDigest}` : visibleTextSignature;
}

const POLL_MS = 1000;
const QUIET_POLLS = 3;
const IDLE_GIVE_UP_MS = 14000;
const TEXT_QUIET_POLLS = 9;
const MAX_MS = 60000;

/**
 * Waits for a click's network activity to settle so the verification snapshot
 * reflects the post-click page rather than a fixed-delay guess. Elapsed time is
 * accumulated from poll counts so fake pages and timers stay deterministic.
 * When `readText` is given, visible-text movement since the pre-click baseline
 * also counts as activity, so a DOM-only re-render that lands after the first
 * change is not snapshotted half-transitioned; the wait ends once activity has been quiet for the quiet window and is
 * bounded by the MAX_MS ceiling so a never-quiet page still terminates.
 * When `readQuiescence` is given, in-flight fetch/XHR the capture never counts
 * and DOM mutations are read from the page itself: either one is activity, and
 * the wait only ends once the page reports idle, so the fixed text quiet window
 * is no longer a guess about how late a re-render can land.
 * A submit-shaped click whose text moved keeps waiting until the same idle allowance a silent
 * one gets, since a header flip can precede the body re-render by many seconds.
 * Only submit-shaped steps keep the long idle wait for a slow round-trip to start;
 * any other click that shows no activity after one quiet poll gives up.
 * The probe is read once before the click (see snapshotPage) so early requests and
 * mutations are counted; settle ends on page quiescence, never on a content predicate.
 */
export async function settleAfterClick(
  page: SettlePage,
  counter: SettleCounter,
  preCount: number,
  submitShaped: boolean,
  readText?: () => Promise<string>,
  preText?: string,
  readQuiescence?: () => Promise<PageQuiescence>
): Promise<void> {
  const read = async (): Promise<string | undefined> => (readText ? readText() : undefined);
  const quiescence = async (): Promise<PageQuiescence | undefined> =>
    readQuiescence ? readQuiescence() : undefined;
  const startQ = await quiescence();
  let lastMutations = startQ?.mutations;
  const startText = await read();
  let lastText = preText ?? startText;
  let textMoved = preText !== undefined && startText !== undefined && startText !== preText;
  let seen = counter.n > preCount || textMoved;
  let last = counter.n;
  let quiet = 0;
  let elapsed = 0;
  while (elapsed < MAX_MS) {
    await page.waitForTimeout(POLL_MS);
    elapsed += POLL_MS;
    const text = await read();
    if (text !== undefined && lastText !== undefined && text !== lastText) {
      lastText = text;
      textMoved = true;
      seen = true;
      quiet = 0;
      continue;
    }
    const q = await quiescence();
    const pageBusy =
      q !== undefined &&
      (q.pending > 0 || (lastMutations !== undefined && q.mutations !== lastMutations));
    if (q !== undefined) lastMutations = q.mutations;
    if (pageBusy) {
      seen = true;
      quiet = 0;
      continue;
    }
    if (counter.n !== last) {
      last = counter.n;
      seen = true;
      quiet = 0;
      continue;
    }
    if (seen) {
      quiet += 1;
      if (!textMoved) {
        if (quiet >= QUIET_POLLS) return;
        continue;
      }
      if (quiet >= TEXT_QUIET_POLLS && (!submitShaped || elapsed >= IDLE_GIVE_UP_MS)) return;
      continue;
    }
    if (!submitShaped || elapsed >= IDLE_GIVE_UP_MS) return;
  }
}

/**
 * Page-side probe that counts requests the network capture never sees and DOM
 * mutations, so settle can tell a finished re-render from a pending one.
 */
export const QUIESCENCE_PROBE_EXPR = `(() => {
  const w = window;
  if (!w.__settleQ) {
    const q = { pending: 0, mutations: 0 };
    w.__settleQ = q;
    const of = w.fetch;
    if (typeof of === "function") {
      w.fetch = function () {
        q.pending += 1;
        const done = () => { q.pending = Math.max(0, q.pending - 1); };
        const p = of.apply(this, arguments);
        p.then(done, done);
        return p;
      };
    }
    const send = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = function () {
      q.pending += 1;
      let finished = false;
      const done = () => { if (!finished) { finished = true; q.pending = Math.max(0, q.pending - 1); } };
      this.addEventListener("loadend", done);
      return send.apply(this, arguments);
    };
    new MutationObserver((list) => { q.mutations += list.length; }).observe(document, {
      subtree: true, childList: true, characterData: true, attributes: true,
    });
  }
  return { pending: w.__settleQ.pending, mutations: w.__settleQ.mutations };
})()`;

export interface SettleSnapshotTarget<
  S extends { networkCount: number; visibleTextSignature: string },
> {
  page: SettlePage;
  counter: SettleCounter;
  pre: S;
  submitShaped: boolean;
  /** Takes a snapshot; `withPage` marks the final post-settle read. */
  snapshot: (withPage: boolean) => Promise<S>;
  readQuiescence?: () => Promise<PageQuiescence>;
}

/**
 * Settles after a click and returns the post snapshot, so the settle wait, the
 * phantom classifier and view-swap detection all decide from one settled
 * snapshot instead of each call site hand-building its own reader.
 */
export async function settleAndSnapshot<
  S extends { networkCount: number; visibleTextSignature: string },
>(target: SettleSnapshotTarget<S>): Promise<S> {
  await settleAfterClick(
    target.page,
    target.counter,
    target.pre.networkCount,
    target.submitShaped,
    async () => (await target.snapshot(false)).visibleTextSignature,
    target.pre.visibleTextSignature,
    target.readQuiescence
  );
  return target.snapshot(true);
}
