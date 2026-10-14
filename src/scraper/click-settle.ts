export interface SettlePage {
  waitForTimeout(ms: number): Promise<void>;
}

export interface SettleCounter {
  n: number;
}

const POLL_MS = 1000;
const QUIET_POLLS = 3;
const IDLE_GIVE_UP_MS = 14000;
const TEXT_QUIET_POLLS = 7;
const MAX_MS = 15000;

/**
 * Waits for a click's network activity to settle so the verification snapshot
 * reflects the post-click page rather than a fixed-delay guess. Elapsed time is
 * accumulated from poll counts so fake pages and timers stay deterministic.
 * When `readText` is given, visible-text movement since the pre-click baseline
 * also counts as activity, so a DOM-only re-render that lands after the first
 * change is not snapshotted half-transitioned; the wait is still bounded by MAX_MS.
 */
export async function settleAfterClick(
  page: SettlePage,
  counter: SettleCounter,
  preCount: number,
  readText?: () => Promise<string>
): Promise<void> {
  const safeRead = async (): Promise<string | undefined> => {
    if (!readText) return undefined;
    try {
      return await readText();
    } catch {
      return undefined;
    }
  };
  let lastText = await safeRead();
  let textMoved = false;
  let seen = counter.n > preCount;
  let last = counter.n;
  let quiet = 0;
  let elapsed = 0;
  while (elapsed < MAX_MS) {
    await page.waitForTimeout(POLL_MS);
    elapsed += POLL_MS;
    const text = await safeRead();
    if (text !== undefined && lastText !== undefined && text !== lastText) {
      lastText = text;
      textMoved = true;
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
      if (quiet >= (textMoved ? TEXT_QUIET_POLLS : QUIET_POLLS)) return;
      continue;
    }
    if (elapsed >= IDLE_GIVE_UP_MS) return;
  }
}
