# Recon on 1.12.5: browser flow STILL truncates mid-run and `recon-browser.ts` exits 0 silently (the #187 "fail loud" guard covers `runHealingFlow`, not the recon CLI loop)

**Filed:** 2026-08-18 · **Barnacle:** 1.12.5 (with `@browserbasehq/stagehand` pinned to 3.6.0) · **Reporter:** live (unnamed) site plugin build
**Site:** `www.example-site.com/catalog` (Next.js SPA; Akamai; OneTrust).
**Flow:** the plugin repo's `src/sites/example-site/recon-flow.json` — 10-step read-only inventory flow (unchanged across every run below).
**Follow-up to:** `recon-1123-flow-truncates-at-step-9-stagehand-370-shutdown.md` (#187). That fix helped but did **not** resolve this on the recon path.

## Summary

After upgrading to **1.12.5** and pinning Stagehand to **3.6.0** (per #187), the
recon browser flow **still truncates mid-run**, and — worse — `recon-browser.ts`
**exits 0 with steps unaccounted for and logs no failure**. #187 added a "fail
loud / reject on mid-flow session death" guard, but it lives in **`runHealingFlow`**
(the runtime browser-*fallback* path), while **`recon:browser` runs its own step
loop in `recon-browser.ts`** — which was not hardened the same way. So the recon
CLI silently reports success on a partial flow.

This still blocks verifying **#182** (its only exercise point, step 10, is never
reached).

## Evidence — five runs, same flow file

| Run | Barnacle | Stagehand | Last step | `socket-close 1006` | Terminal signal | Exit |
|-----|----------|-----------|-----------|---------------------|-----------------|------|
| v1  | 1.12.2   | 3.6.x     | **10/10** | 2 | normal completion | 0 |
| v2  | 1.12.3   | 3.7.0     | 9/10      | 4 | `socket-close 1006` | 0 |
| v3  | 1.12.3   | 3.7.0     | 9/10      | 0 | `shutdown-supervisor` | 0 |
| v4  | 1.12.5   | 3.6.0     | **3/10**  | 0 | *(none — silent stop)* | 0 |
| v5  | 1.12.5   | 3.6.0     | 9/10      | 4 | `socket-close 1006` | 0 |

Two independent facts fall out of this table:

1. **1006 is not the sole cause.** v1 (the run that reached step 10) had two 1006
   drops and still completed; v3/v4 truncated with zero 1006s. The distinguishing
   factor is that on 1.12.3+ the recon loop **stops** on mid-flow disruption
   instead of continuing through the remaining steps as 1.12.2 did.
2. **The recon loop reports success on a partial flow.** Every 1.12.5 run exited
   **0** having executed a fraction of the flow (3/10, 9/10), with **no failure
   line, no rejection, no "unaccounted steps" error** in the recon output.

## Root cause — the #187 "fail loud" guard is on the wrong code path

- #187's mid-flow-death rejection is implemented and tested against
  **`runHealingFlow`** (`src/scraper/flow-runner.mid-flow-session-death.test.ts`:
  *"rejects instead of resolving when the session dies after step 8 of a 10-step
  flow"*). `runHealingFlow` is the **runtime browser-fallback** entry.
- **`recon:browser` does not go through `runHealingFlow`.** `src/scripts/recon-browser.ts`
  has its **own** step loop — `for (const step of steps)` (~line 725) — and even
  carries a doc comment about a *"Last-line invariant for the step loop … an
  unaccounted-for stop mid-step must not be reported [as success]"* (~line 259/322).
  That invariant is exactly what is being violated: the loop stops mid-step and the
  script still exits 0.
- Net: the guard that would turn a truncated flow into a loud failure was added to
  the fallback path, not to the recon CLI path that actually truncates here.

## Possible contributing factor — `keepAlive:true` vs the SDK keep-alive patch

#187 sets `keepAlive:true` on the Stagehand constructor for **both** session
builders (`session-browserbase.ts:107`, `session-steel.ts:107`) to stop the
3.7.x shutdown supervisor. Separately, the **plugin repo's load-bearing**
`patches/@browserbasehq__sdk.patch` disables **HTTP** keep-alive in the
Browserbase SDK precisely to prevent socket reuse after a NAT gateway closes it —
the `Premature close` / `socket-close 1006` class. These are different layers, but
the reappearance of 1006 drops on the `keepAlive:true` builds (v2, v5) alongside a
flow that no longer survives them is worth investigating: if the Stagehand-level
keepAlive re-establishes a long-lived CDP/websocket that the NAT still reaps, the
recon loop needs to *recover* from that drop (as 1.12.2 did) rather than end.

Note: 3.6.0 **also ships** `lib/v3/shutdown/supervisor.js` (it is NOT absent in
3.6.x, contrary to the #187 commit message) — so the version pin alone does not
remove the supervisor; only the `keepAlive:true` path suppresses it. This is worth
correcting in the #187 rationale.

## Suggested fixes (engine — not worked around in the plugin repo)

1. **Apply the mid-flow-death guard to `recon-browser.ts`'s own loop**, not just
   `runHealingFlow`. If the session dies or a step ends with steps unaccounted for,
   the recon script must **exit non-zero and log the truncation** — the invariant
   its own comment already promises. A silent exit 0 on a 3/10 flow is the most
   dangerous part of this: `recon:generate` and CI treat it as a complete run.
2. **Make the recon loop recover from a mid-flow CDP drop** the way 1.12.2 did
   (re-establish the session / continue), rather than ending the flow. v1 tolerated
   two 1006 drops and finished all 10 steps; 1.12.5 does not.
3. **Investigate the `keepAlive:true` ↔ NAT-socket-reuse interaction** above;
   if Stagehand-level keepAlive reintroduces reaped-socket drops, reconcile it with
   the SDK-level keep-alive-disable the deployment depends on.

## Impact / severity

High. On 1.12.5 the recon browser flow does not reliably complete, and — because
the recon CLI exits 0 on a partial run — the truncation is invisible to
`recon:generate` and CI. For **this** plugin the hot-path data
(`catalogSearch_Items`, ~554 KB) is captured before the truncation point, so the
generated contract is still correct; but the browser fallback flow cannot be run
end to end, and **#182 remains unverifiable** until the recon flow reaches step 10.

## Evidence on disk

- Run dirs: `/tmp/recon/example-site-2026081*-*` (v4 `…-230118`, v5 `…-v5`) with
  `graphql/` captures; each `catalogSearch_Items` present at 200 (~554 KB).
- Recon logs (per-run step verdicts + terminal signals) captured by the plugin build.
- Version facts: `@enricai/barnacle@1.12.5`, `@browserbasehq/stagehand@3.6.0`
  (pinned in the plugin repo's own `package.json` at `~3.6.0`), SDK patch applied
  (`_patch_hash` suffix present).
