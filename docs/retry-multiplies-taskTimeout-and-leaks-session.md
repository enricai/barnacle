# `withScraperRetry` multiplies `taskTimeoutMs` ×3 and leaks the session on repeat timeouts

**Status:** fixed · **Severity:** cost (wasted Browserbase minutes) + reliability
**Found:** 2026-07-23, from prod telemetry + code trace · **Repo:** `@enricai/barnacle` (engine)

## Fix

Fixed by:

- `3e97d54` — `fix(scraper): abort StepVerificationError retries, close session on every timeout`.
  `withScraperRetry` (`src/scraper/retry.ts`) now converts `StepVerificationError` to an
  `AbortError` like `CaptchaError`/`EmptyResultsError`, and the one-shot
  `sessionRestartEntry.done` guard on `onSessionRestart` was dropped so the Steel session is
  torn down on every `SessionTimeoutError`, not just the first.
- `74b9444` — `fix(plugins): thread maxAttempts from plugin meta to runWithSession`. Both
  `loader.ts` browser-fallback call sites now forward `plugin.meta.maxAttempts`, so a plugin
  can bound its own per-run retry budget (e.g. `maxAttempts: 1`) instead of always getting the
  hard-coded default of 3.
- `5847e91` — `docs(readme): document SitePluginMeta.maxAttempts`.
- `2a722b1` and this doc sweep — updated README.md, `docs/architecture.md`, and
  `docs/playbook.md` retry-policy descriptions to describe the shipped behavior.

Net effect: `StepVerificationError` (a deterministic verification failure) now aborts after a
single attempt instead of re-running the whole flow 2 more times; a plugin can set
`maxAttempts: 1` so `taskTimeoutMs` is a real per-run cap instead of `3 × taskTimeoutMs`; and a
stuck Steel session is closed on every timeout instead of leaking for the 2nd/3rd attempt.

## Summary

A stuck browser-fallback run did **not** stop at the plugin's `taskTimeoutMs`. Two engine behaviors
combined so a "10-minute cap" became **~30 minutes** of grind, with the Browserbase session
**leaked** for the last two thirds of it:

1. **`taskTimeoutMs` is a per-*attempt* bound, and `withScraperRetry` runs up to 3 attempts, each
   re-running the entire flow from scratch** → the effective per-*run* ceiling was
   `3 × taskTimeoutMs`.
2. **Session cleanup on timeout was one-shot** → after the first `SessionTimeoutError` the session
   was not closed on the 2nd/3rd timeout.

This is why a plugin that set `taskTimeoutMs: 600_000` (10 min) still produced runs of **1599s,
1842s, and 5515s** in prod.

## Evidence (prod, HCA plugin, `taskTimeoutMs: 600_000`)

Grind `requestId=6SupNQm8J0sN0v-TDpqzt`, `/prod/vivian-barnacle`, 2026-07-23, `durationMs = 1599s`:

```
10:41  attempt 1: whole 55-step flow runs → fails at step 23 (StepVerificationError, ~6 min)
10:48  attempt 2: whole flow RESTARTS from step 1 → hits 600s cap → SessionTimeoutError
       "restarting scraper session after timeout"          ← session closed (first timeout only)
10:57  attempt 3: whole flow RESTARTS AGAIN → hits 600s cap → SessionTimeoutError, "0 retries left"
       (NO "restarting scraper session" log)               ← session NOT closed this time
11:07  run ends. total ≈ 1599s ≈ 3 × ~530s
```

Two other prod grinds: `en9aFXj7IN1kA1x3PRQTX` (1842s), `zlRvxzzPpcsRq3tKo4E4I` (5515s).
`durationMs` is `Date.now() - startedAt` measured in `plugins/loader.ts:225/259` when the pipeline
`await` finally returns — i.e. real wall-clock, not teardown.

## Root cause (a): per-attempt timeout × whole-flow retry

- `scraper/pool.ts:63-83` — `runWithSession` runs `Promise.race([task(session), timeout])` where
  `timeout` rejects with `SessionTimeoutError` after `taskTimeoutMs` (`pool.ts:67-73`). This bound
  is **per call of `task`**.
- `scraper/retry.ts:42-95` — `withScraperRetry` wraps `task` with `pRetry`, default
  `maxAttempts = 3` (`retry.ts:46`, `retries: maxAttempts - 1` at `:79`). On failure it
  **re-invokes `task()` from the top** — there is no resume-from-failed-step; `task` = the
  plugin's whole `execute()` → `runHealingFlow` over all steps. So each retry re-does every
  already-passed step, then times out again.
- `plugins/loader.ts:154-164` — the browser fallback called `runWithSession((s) =>
  plugin.execute(...), { onRetry }, plugin.meta.taskTimeoutMs, …)`. It passed `onRetry` but
  **not `maxAttempts`**, so a plugin could not lower the retry count; every plugin got 3.

Net: `effective per-run ceiling = maxAttempts × taskTimeoutMs = 3 × 10min = 30min`, and each
attempt wastefully re-ran the steps that already succeeded.

Additionally, `StepVerificationError` **was retried** (`retry.ts:53-75`): only `CaptchaError` and
`EmptyResultsError` were converted to `AbortError`; `StepVerificationError` fell through to
`throw err` → p-retry retried it. A `StepVerificationError` from a broken step is
**deterministic** — re-running the whole flow to fail on the same step 3× was pure waste
(confirmed by the trace: attempt 1 fails at step 23, attempts 2&3 re-run and time out).

## Root cause (b): one-shot session cleanup

`retry.ts:47,68-73` (pre-fix):

```ts
const sessionRestartEntry: { done: boolean } = { done: false };
...
if (err instanceof SessionTimeoutError && !sessionRestartEntry.done) {
  sessionRestartEntry.done = true;
  if (options.onSessionRestart) { await options.onSessionRestart(); }  // closes the session
}
```

`onSessionRestart` (the `closeSession` in `pool.ts:78-81`) ran only on the **first**
`SessionTimeoutError`. On the 2nd/3rd timeout the guard was false, so the stuck session was
**not** torn down before the next attempt — confirmed by the missing "restarting scraper session
after timeout" log on attempt 3 in the trace. (The outer `finally` in `pool.ts:84` closed at the
very end, but not between the repeat timeouts.)

## Impact

- **Cost:** a stuck run burned up to `3 × taskTimeoutMs` of Browserbase time instead of the
  intended cap. At the observed 1599–1842s (and one 5515s), each grind was ~26–92 min of paid
  session time.
- **Reliability optics:** telemetry `durationMs` far exceeded the plugin's stated
  `taskTimeoutMs`, making the cap look ineffective (it was, at the run level).
- **Note for consumers:** a plugin adding `taskTimeoutMs` to "cap the grind" (as HCA did in
  nursefly-web `#84`) did not get the cap it expected — the real ceiling was 3×.

## Cross-reference

The plugin side (the *trigger* — the HCA step that kept failing, plus the still-omitted
`maxFlowMs`) is tracked in `nursefly/autoapply` `docs/hca-grind-step23-and-retry.md`. The
`taskTimeoutMs: 600_000` cap and the self-ID/phantom-success fixes shipped there in `#84`
(`70b6213b`, 2026-07-21) — this report was the remaining engine-side reason those caps didn't
fully bound the grind.

## What this is NOT

Encompass `ORA_URL_LOCKED` failures are an expected Oracle requisition-URL throttle (→ HTTP 429 →
`RETRY_LATER`), correctly handled and out of scope here.
