# Recon: flow truncates at step 9/10 — Stagehand 3.7.0's shutdown supervisor force-releases the session mid-flow

**Filed:** 2026-08-19 · **Barnacle:** 1.12.3

## The mechanism

Stagehand 3.7.0/3.7.1 spawn an out-of-process crash-cleanup supervisor
whenever a session is created without `keepAlive: true`. The supervisor
watches its own stdin lifeline pipe and force-releases the Stagehand session
the moment that pipe closes — a heuristic that produced false positives
against Barnacle's own session lifecycle (Barnacle already owns explicit
teardown via `close()` on the session, plus a try/finally around init
failure). The result: a live recon run's session gets torn down by the
supervisor mid-flow, partway through a multi-step plan.

Once the underlying Stagehand `Page` is dead, `page.url()` throws
synchronously. Every downstream probe (`guardedObserve`/`guardedAct`) treats
a thrown error the same way it treats "no candidates right now" — for an
optional step, that reads as a legitimate skip, not a fatal error. Nothing in
the loop distinguished "step legitimately absent" from "session is gone" — so
the loop ran to completion, `runHealingFlow` resolved as if all steps
finished, and `recon-browser.ts`'s CLI reported success, even though the
session died at step 9 of 10.

## The fix

- **Engine (`session-steel.ts`, `session-browserbase.ts`):** pass
  `keepAlive: true` to Stagehand's session constructor. Barnacle owns
  teardown explicitly; the supervisor's stdin-close heuristic added risk on
  top of that, not additional safety.
- **`flow-runner.ts`:** a liveness gate at the top of the step loop —
  `page.url()` is the one call every Page implementation answers without
  touching the DOM. A throw there now aborts the flow with a
  `SessionTimeoutError` naming how many of the declared steps actually
  completed, instead of allowing the loop to run out and resolve
  successfully.
- **`recon-browser.ts`:** a last-line invariant (`isFlowTruncated`) at the
  end of the CLI's own step loop — the loop can only legitimately fall
  through by completing every step or by the trailing-grace break on a
  stalled trailing-optional step. Any other way of reaching the end is
  reported as a truncated flow (`process.exit(1)`), not a successful run.

## Regression coverage

- `src/scraper/flow-runner.mid-flow-session-death.test.ts` — a session that
  dies at step 8 of 10 must make `runHealingFlow`'s promise reject, not
  resolve.
- `src/scraper/session-steel.test.ts`, `src/scraper/session-browserbase.test.ts` —
  `keepAlive: true` is passed to the Stagehand constructor.
- `src/scripts/recon-browser.test.ts` — `isFlowTruncated` covers the
  completed/trailing-grace/truncated cases.
- `src/dependency-pins.test.ts` — locks `@browserbasehq/stagehand`'s
  declared range below 3.7.0 so this regression cannot be silently
  re-admitted by a future range bump.
