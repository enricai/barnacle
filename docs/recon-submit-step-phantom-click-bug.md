# Bug: recon submit step "phantom-clicks" — Stagehand AISDK elementId resolution fails, run aborts before submit

**Component:** recon (`recon-browser`) + Stagehand act/observe integration (`session-browserbase`)
**Severity:** High for this use case — the recon can never reach the submit / post-submit state on
this site, so it cannot capture the submit response or any post-submit page/cookie state.
**Found:** 2026-07-18, `@enricai/barnacle@1.6.1`, running a browser recon against Appcast's Angular
apply form (`apply.appcast.io/jobs/{id}/applyboard/apply`).
**Reporter:** Vivian auto-apply.

---

## Summary

On the final **"Click the Submit button"** step, Stagehand reports the click as **successful** but
**nothing actually happens** — no network request, no URL change, no DOM change. All five cascade
techniques exhaust on this "phantom click," the global replan budget is consumed, and
`recon-browser` **aborts before the application is ever submitted**. The run therefore never reaches
the submit POST or the post-submit / confirmation page.

Alongside it the engine logs (once, at teardown):

```
stagehand-logger: suppressed 26 AISDK elementId-regex errors (upstream Stagehand bug;
cascade Fix 1B handles consequence)
```

i.e. Stagehand's AISDK element-id resolution is throwing repeatedly during this run — the engine
is aware of it and suppresses/absorbs it, but the downstream consequence (the submit control never
actually gets clicked) still fails the run.

## Exact failure (from the run + diagnostic bundle)

Step: `Click the Submit button to submit the application form`
Page: `https://apply.appcast.io/jobs/52270016990/applyboard/apply` (title "Registered Nurse"),
form pre-check clean (`step 77 pre-submit probe: no ng-invalid form controls detected`).

Diagnostic bundle `/tmp/recon/step-failures/076-click-the-submit-button-.json` — all 5 attempts:

| attempt | technique | Stagehand result | pre→post net | pre→post html | url changed |
|---|---|---|---|---|---|
| 1 | act-string | **success** | 0 → 0 | 184186 → 184186 | no |
| 2 | observe-act | **success** | 0 → 0 | 184186 → 184186 | no |
| 3 | structured-click | error: "no checkable input reachable from prior selector" | 0 → 0 | unchanged | no |
| 4 | observe-act-exclude | error: "observe returned no candidates" | 0 → 0 | unchanged | no |
| 5 | llm-rephrase | **success** | 0 → 0 | 184186 → 184216 (+30B) | no |

The key signal: attempts 1, 2, 5 return **`actResultSuccess: true` with zero observable effect** —
Stagehand believes it clicked, but no click event reached the app. Attempts 3–4 couldn't resolve a
target at all. Then: `step 77 failed after 5 attempts` → cascade-exhausted → replans exhausted →
`recon-browser failed: step 77 … failed verification after 5 attempts`.

Corroborating detail from the captured DOM in the bundle (`bodyOuterHtml`, ~184KB): the outer HTML
contains **no `type="submit"` and no literal "Submit" button text** — the actual submit control is
almost certainly inside a web component / shadow root / Angular-rendered control that Stagehand's
element resolver can't bind to. This is consistent with the 26 `elementId-regex` errors: the
resolver produces an id it then can't map back to a real, clickable element, so the "click"
dispatches to nothing.

## Impact

- **Recon cannot complete the apply on this site.** It fills the entire form successfully (76 steps)
  and only dies at the terminal submit — so every run wastes the full form-fill and still yields no
  submit.
- **No post-submit data.** Because it never submits, the recon cannot capture the `/integrated_apply`
  request/response, the confirmation/`applied` page, or any post-submit page/cookie state — which is
  specifically what we needed this run for.
- **False "success" masks the failure per-attempt.** `actResultSuccess: true` on a click that did
  nothing means the cascade only catches it via the no-observable-effect verifier, after burning all
  5 techniques + replans. Faster/clearer detection of a phantom click would save a lot of run time.

## What we think needs fixing (Barnacle team to decide)

1. **The upstream Stagehand AISDK elementId-regex errors** the engine is already suppressing are not
   harmless here — they correlate 1:1 with the submit control being unclickable. Whatever "cascade
   Fix 1B handles consequence" refers to, it does **not** recover this case. Worth revisiting whether
   the suppressed errors should instead drive a different resolution strategy for the submit control.
2. **Phantom-click detection:** when Stagehand returns `success` but pre/post show zero net + zero
   url + zero DOM delta, that's a phantom click — the cascade could detect and escalate immediately
   rather than repeating techniques that all no-op the same way.
3. **Shadow-DOM / web-component / Angular submit control resolution:** the submit button isn't in the
   light-DOM outer HTML; a resolution path that can reach controls inside shadow roots / framework-
   rendered components would address the root cause.

## Reproduction

```
pnpm tsx --env-file=.env node_modules/@enricai/barnacle/dist/scripts/recon-browser.js \
  --url "https://apply.appcast.io/jobs/52270016990/applyboard/apply?cs=sy3&exch=7t&jg=8w6i" \
  --flow-file src/sites/appcast/recon-flow.json \
  --provider browserbase --advanced-stealth --allocate-email RECON_EMAIL
```
(Any current `apply.appcast.io/jobs/{id}/applyboard/apply` job reproduces; the flow reaches the
submit step, then fails as above. Diagnostic bundle at `/tmp/recon/step-failures/*click-the-submit*`.)

## Notes

- Not the same as the temp-dir namespacing bug (separate report:
  `recon-temp-dir-namespacing-bug.md`). This one is about the submit step being unclickable.
- The cookie-jar capture added in 1.6.1 worked correctly right up to the submit step (161 snapshots
  captured), so this bug does not affect pre-submit telemetry — only the ability to reach and capture
  the submit + post-submit state.

---

## Test coverage findings

Findings from the testing-domain follow-up work on remedy #3 (shadow-DOM / web-component submit
control resolution). The runner-up-retry gap identified below has since been closed in code (see
"Resolution" at the end of this section) — the finding is kept for the investigation trail.

### Unwired runner-up retry (resolved)

`buildClickByDeepIndexExpr` (`src/scraper/submit-control.ts`) is built and documented explicitly to
support retrying a lower-ranked candidate when the top-ranked one phantom-clicks — the module TSDoc
(`src/scraper/submit-control.ts:4-5`) states the deep-query ranking exists "so the cascade can act on
the best-ranked candidate and retry the runner-up if the first click phantoms." The function itself
takes an arbitrary `deepIndex`, not just the top candidate's, which is what makes that retry possible.

At the time this finding was recorded, the only caller, `flow-runner.ts`'s attempt-2
`deep-submit-locator` branch, did not use this capability: it clicked `ranked[0]` once and on failure
fell through to the cascade's next attempt (3/4/5) rather than retrying `ranked[1]` within the same
deep-submit-locator technique.

`submit-control.test.ts` covered the capability at the module level; `flow-runner.test.ts`
independently confirmed, from the caller side, that the ranked-empty and stale-deepIndex branches both
fell through to the cascade's normal continue/skip machinery deterministically (no ambiguous
intermediate state) rather than ever attempting a runner-up click.

**Resolution:** `flow-runner.ts`'s `deep-submit-locator` branch now retries `ranked[1]` in the same
attempt-2 slot when the top pick's click is classified as a phantom (zero net/url/DOM delta), and
separately retries the rank+click once when the top pick's click itself reports `clicked: false`
(stale `deepIndex` from a re-render between the rank and click round trips). See
`src/scraper/flow-runner.ts`'s `deep-submit-locator` branch and the phantom-click-escalation suite in
`flow-runner.test.ts` for the caller-side coverage, and `submit-control.test.ts`'s
"can click a lower-ranked candidate by deepIndex" test for the module-primitive coverage.
