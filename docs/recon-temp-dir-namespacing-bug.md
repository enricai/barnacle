# Bug: recon temp output directories are not namespaced per run

**Component:** recon tooling — `recon-browser`, `recon-http`, `recon-generate`
**Severity:** Medium — silent cross-run data corruption; no crash, wrong/mixed data
**Found:** 2026-07-18 (v1.6.1), during a downstream Appcast cookie-capture recon
**Reporter:** Vivian auto-apply (consumer of `@enricai/barnacle`)
**Status:** Resolved (2026-07-18)

---

## Resolution

Fixed via option 1 from the "Requested fix" section below — a per-run subdirectory,
`resolveReconRunDir()` in `src/scripts/recon-shared.ts`, roots every recon run at
`<out-dir>/<runId>/{graphql,cookies,replays,aux,step-failures}`. `<runId>` is a
timestamp + random suffix generated once per process (e.g. `20260718-120326-a1b2`)
and memoized so every call site in one run shares the same root — the `NNN` counter
now lives inside a run-scoped directory instead of a shared global one, so it can no
longer collide across runs. `RECON_RUN_ID` pins a deterministic runId (tests, or
replaying a known run); `RECON_OUT_DIR` overrides the `/tmp/recon` base directory.
Readers (`recon-generate`, `recon-summarize`) resolve via
`resolveLatestReconRunRoot()`: an explicit `--run-dir <path>` wins, then
`RECON_RUN_ID`, then the most recently modified run root — preserving the existing
"recon, then generate" two-command workflow without requiring operators to pass a
run dir by hand.

Implemented across:
- `453abd2` — add the run-scoped output directory resolver to `recon-shared`
- `64f3db9` — route `recon-browser` output through the resolved run dir
- `2af0fa3` — route `recon-http` output through the run-scoped resolver
- `0e0cbe5` — migrate flow-runner, `recon-generate`, `recon-summarize` to the run-dir seam

The legacy `CAPTURES_DIR` / `REPLAYS_DIR` / `AUX_DIR` / `STEP_FAILURES_DIR` /
`COOKIES_DIR` constants in `recon-shared.ts` remain exported for back-compat (the
module is a published package subpath) but are no longer consumed by any recon
script — new callers use `resolveReconRunDir()`. README.md's pipeline table and
`recon:browser`/`recon:http`/`recon:generate`/`recon:summarize` sections now
describe the run-scoped layout and document `RECON_OUT_DIR`, `RECON_RUN_ID`,
`--out-dir`, and `--run-dir`.

---

## Summary

All recon output directories are **hardcoded, process-global path constants** with no per-run
namespacing and no override (env var, CLI flag, or param). Every recon run — regardless of site,
URL, or invocation — writes into the **same** `/tmp/recon/*` directories, using a per-run counter
that **restarts at `000` each run**. Consequences:

- **Concurrent runs collide.** Two recons at once write interleaved files into the same dir, and
  files with the same `NNN-<label>-<phase>` name **silently overwrite** each other (last writer
  wins).
- **Sequential / cancelled runs contaminate.** A prior (finished or cancelled) run's files remain
  in the dir and intermix with the next run's. Because the counter resets to `000`, filenames alone
  cannot tell which run a file belongs to.

Both cases are **silent** — no warning, no error. Downstream consumers (`recon-generate`, manual
analysis, cookie-jar snapshots) read a directory that may hold a mix of 2–3 runs.

## Root cause

`src/scripts/recon-shared.ts:10-14` — module-level constants, consumed directly by all recon
scripts:

```ts
export const CAPTURES_DIR      = "/tmp/recon/graphql";
export const REPLAYS_DIR       = "/tmp/recon/replays";
export const AUX_DIR           = "/tmp/recon/aux";
export const STEP_FAILURES_DIR = "/tmp/recon/step-failures";
export const COOKIES_DIR       = "/tmp/recon/cookies";
```

- `recon-browser.ts` writes captures and cookie-jar snapshots straight to these constants
  (`writeFileSync(join(CAPTURES_DIR, filename), …)`, `join(COOKIES_DIR, filename)`), with filenames
  `NNN-<label>-<phase>.json` / `NNN-<phase>-<epoch>-<hash>.json` where `NNN` is a per-run counter
  starting at `000`.
- `src/scripts/recon-http.ts:34-35,232` **re-declares the same paths as local literals**
  (`const CAPTURES_DIR = "/tmp/recon/graphql"`, etc.) — so the HTTP probe shares the collision
  surface. (There is a `let capturesDir = CAPTURES_DIR` local in that file — a partial seam — but it
  is seeded from the global constant and not exposed to callers.)
- No env var, CLI flag, or param overrides any of these paths.

## Evidence (this incident)

We ended up with **three runs' files intermixed in `/tmp/recon/cookies/`**:
1. An earlier **cruise-site** recon (files labeled `...cruise...`, `...show-more...`).
2. A **cancelled** first Appcast run (partial orphan files).
3. The **current** Appcast run (the one we wanted).

All three share the `000…` counter, so `000-goto-home.json` / `0NN-<label>.json` from different runs
occupy or overwrite the same names. We could only isolate the current run by **file mtime**
(`find /tmp/recon/cookies -newermt '<run start>'`) — a fragile workaround that fails entirely for
**concurrent** runs, where mtimes interleave.

## Impact

- **Cross-run corruption** in `recon-generate` and manual analysis: output can be built from a mix
  of runs, or from files silently overwritten mid-run.
- **No safe concurrency:** two recons cannot run at once on one machine/container.
- **Debugging cost:** operators must manually distinguish runs by mtime and remember to clear
  `/tmp/recon/*` between runs, with no warning if they forget.

## Requested fix (report only — not implemented here)

Namespace recon output per run. In rough order of preference:

1. **Per-run subdirectory** — root each run at `/tmp/recon/<runId>/{graphql,cookies,replays,aux,
   step-failures}`, `<runId>` = run-start timestamp + short random/pid (e.g. `20260718-120326-a1b2`).
   `recon-generate` takes the run dir as input. Cleanest; also makes runs individually archivable.
2. **`--out-dir` flag (+ optional `RECON_OUT_DIR` env)** defaulting to current paths for
   back-compat, threaded through `recon-shared` instead of hardcoded constants.
3. **Minimum:** on run start, either refuse to run if target dirs are non-empty (fail loud instead
   of silently mixing) or rotate them, and log the run's output location + run id prominently.

Whatever the approach, the counter/filename scheme must be unique per run (or scoped under a run
dir) so `000-goto-home.json` from run A cannot collide with run B.

## Notes

- Surfaced while using the v1.6.1 cookie-jar capture (`cookie-jar.ts` / `COOKIES_DIR` snapshots) —
  that feature works correctly; this is purely about **where** recon output lands.
- Not blocking the downstream investigation (we isolated by mtime), but a real trap for repeated
  runs and a hard blocker for concurrent runs.

---

# Additional recon findings (v1.6.1, disneycruise investigation)

**Reporter:** downstream consumer (cruiselines). **Found:** 2026-07-18 against
`@enricai/barnacle@1.6.1`.

Appended here per request. First — a real-world confirmation of the namespacing bug above; then
two independent findings surfaced in the same session. Every claim below was reproduced by
running the shipped code; line numbers are from `1.6.1` (`9db01ad`) and may drift.

## 0. The namespacing bug bit this session (confirmation of the above)

While isolating a cookie-binding issue, `recon:browser` reported `319 captures written` but
`/tmp/recon/graphql` held **535 files**. Clustering by capture-epoch → **7 distinct runs
intermixed** (three separate `000-home-*.json`). Cause: a first recon plus several
`recon:generate --force` re-runs, all writing to the same unnamespaced dir.

Concrete downstream cost: it produced a **false-positive bug diagnosis** — a cookie defect was
first blamed on contamination, and only re-confirmed after manually isolating one run's captures
by epoch. This is exactly the "silent cross-run corruption" the report predicts; recording it as
lived evidence for the Medium severity.

## 1. Cookie binding drops the auth cookie — TWO independent gates

**Component:** `recon-generate` — `walkSetCookiePairs` + `indexStateValues`
**Severity:** High — generated `executeHttp` for a stateful API binds the wrong cookies and 401s.

On disneycruise, `POST /dcl-apps-productavail-vas/authz/private` mints the session cookie `__pa`
(a JWT); `available-products/` returns **200 with `__pa`, 401 without** (verified by curl). The
1.6.1 capture fix (`responseReceivedExtraInfo`) correctly records `__pa` in the capture. But
`recon:generate` emits a `bind:` that threads `Conversation_UUID` and `ADRUM_BTa` — **not `__pa`**
— so the generated plugin still 401s.

`__pa` is excluded by **two gates; fixing either alone leaves it excluded.** Proven by patching
each and re-running `indexStateValues` on the real captures:

| `walkSetCookiePairs` | `MAX_STATE_VALUE_LENGTH` | `__pa` indexed? |
|---|---|---|
| `split(";",1)[0]` (current) | 256 (current) | ❌ |
| newline-iterating | 256 | ❌ |
| current | 4096 | ❌ |
| **newline-iterating** | **4096** | **✅** |

**Gate A — `walkSetCookiePairs` (`recon-generate.ts:1243`) parses only the first cookie.**
```ts
const pair = rawSetCookie.split(";", 1)[0] ?? "";   // first cookie only, then returns
```
The captured `authz/private` `Set-Cookie` is one **1275-char string of 7 cookies joined by `\n`**
(`ADRUM_BTa, ADRUM_BTa, ADRUM_BT1×3, __pa, bm_sv`). `split(";", 1)` cuts at the first *attribute*
delimiter and returns only cookie 0 (`ADRUM_BTa`). `__pa` is cookie 5 — never parsed. The
function's own docstring claims it handles "multiple `Set-Cookie` entries via
`Headers.getSetCookie()`"; the code does not. (`split("\n")` extracts all 7, `__pa` included —
verified at the string level.)

**Gate B — `MAX_STATE_VALUE_LENGTH = 256` (`:1221`) drops the 272-char JWT.**
Even once parsed, `if (value.length > MAX_STATE_VALUE_LENGTH) continue;` (`:~1302`) excludes
`__pa` (272 chars). The cap's docstring targets "massive blobs (HTML fragments, base64 images)" —
an opaque auth token legitimately exceeds 256.

**Why the decoys bind and `__pa` doesn't:** `Conversation_UUID` (36) and `ADRUM_BTa` (43) pass
both gates and reappear in later request headers, so they're selected. `__pa` never enters
`stateIndex`.

**Fix (author's call):** Gate A — iterate all newline-delimited cookies in `walkSetCookiePairs`.
Gate B — exempt `set-cookie`-origin values from `MAX_STATE_VALUE_LENGTH`, or raise it for cookies.
Both are required.

## 2. Rate-limit probe ignores the noise filter the replay phase applies

**Component:** `recon-http`
**Severity:** Low — wasted time + fires third-party ad pixels from the egress IP.

`recon-http` filters noise for the replay phase but not the rate-limit phase — the two build their
target lists independently:

- **Replay (`recon-http.ts:395`):** `unique.filter(({capture}) => !isNoiseUrl(capture.url))` —
  host+telemetry aware. This run: `74 probeworthy (211 asset/telemetry/error hosts filtered)`.
- **Rate-limit (`:439-440`):** rebuilds `probeTargets` from the **raw `replays`** list with only a
  **path-suffix** check (`.json`, `markets|currencies|config|…`) — **no `isNoiseUrl`**.

So the rate-limit probe hits `analytics.tiktokw.us`, `bat.bing.com`, `www.google.com/pagead`,
`googleadservices.com`, `tr.snapchat.com`, `sp.analytics.yahoo.com`, and **12+ distinct Adobe
`sw88.go.com` beacon paths** — 60 requests each (1→3→5 rps × 20). Its cost scales with every
telemetry variant captured, not with the 74 real endpoints.

**Fix:** probe the already-computed `probeworthy` set, or add `if (isNoiseUrl(replay.url)) continue;`
in the `:440` loop (`isNoiseUrl` is already imported at `:28`).

## Not-bugs (recorded so they aren't re-investigated)

- **Multi-step `ResponseSchema = z.unknown()` is correct.** A submission flow's response schema is
  the plugin's contract with its caller (e.g. `{ verified: boolean }`), a field that appears in no
  captured response — not inferable from captures. The `[ ] Narrow the ResponseSchema` checklist is
  the intended handoff.
- **recon:http does not crash.** The rate-limit probe is O(endpoints × 60 req); on this site it
  runs well past 20 min and writes `rate-limit.json` only at the end (exit 0 confirmed). An earlier
  "crash" was an external `timeout` killing it mid-probe. (Finding 2 is why it takes so long.)

## Context from this run (may be useful)

- **1.6.1 fixed the prior batch:** generated plugin now typechecks clean out-of-tree (was 10
  errors on 1.3.1), emits `@enricai/barnacle/*` subpaths, no longer replays the browser's
  `/error` posts, and — with a fresh run — captures `Set-Cookie` (the CDP `responseReceivedExtraInfo`
  fix works).
- **Rate-limit ceiling:** 44 endpoints probed, **0 hit 429/403**; every Disney API endpoint
  (`authz/private`, `toggles`, `/api/navigation/*`) reported `safeRps=5`. The API tolerates ≥5 rps
  (probe ceiling; higher untested).
- **Real `Capture` fixtures** at
  `cruiselines/src/sites/disneycruise/fixtures/`: `available-products-unfiltered.json` (699
  cruises, 13 levels deep), `available-products-7night.json` (same endpoint, different body),
  `authz-private.json` (the `__pa` mint — its `Set-Cookie` is the multi-cookie string in Finding 1).
