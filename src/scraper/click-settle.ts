export interface SettlePage {
  waitForTimeout(ms: number): Promise<void>;
}

export interface SettleCounter {
  n: number;
}

const POLL_MS = 1000;
const QUIET_POLLS = 3;
const IDLE_GIVE_UP_MS = 4000;
const MAX_MS = 15000;

/**
 * Waits for a click's network activity to settle so the verification snapshot
 * reflects the post-click page rather than a fixed-delay guess. Elapsed time is
 * accumulated from poll counts so fake pages and timers stay deterministic.
 */
export async function settleAfterClick(
  page: SettlePage,
  counter: SettleCounter,
  preCount: number,
): Promise<void> {
  let seen = counter.n > preCount;
  let last = counter.n;
  let quiet = 0;
  let elapsed = 0;
  while (elapsed < MAX_MS) {
    await page.waitForTimeout(POLL_MS);
    elapsed += POLL_MS;
    if (counter.n !== last) {
      last = counter.n;
      seen = true;
      quiet = 0;
      continue;
    }
    if (seen) {
      quiet += 1;
      if (quiet >= QUIET_POLLS) return;
      continue;
    }
    if (elapsed >= IDLE_GIVE_UP_MS) return;
  }
}
