# Bug (follow-up): phantom-click escalation is over-scoped — fires on non-submit controls and skips the fallbacks that would handle them

**Component:** recon cascade — `flow-runner.ts` (attempt-technique escalation) + `scraper/submit-control.ts`
**Severity:** Medium — on required non-submit controls it can fail a step that 1.6.1's fallbacks would
have resolved; on optional ones it's harmless but wastes ~90s per step.
**Found:** 2026-07-19, `@enricai/barnacle@1.6.2`, Angular apply-form recon.
**Status:** fixed in 1.6.3 (commit d3a22fb). The phantom short-circuit is now gated on an optional
`submitShapedStep` (`isFinalStep || submitStep`) condition in `shouldSkipTechnique` and the attempt-2
technique selector/executor in `src/scraper/flow-runner.ts`. Non-submit phantoms are still recorded but
fall through to the normal `structured-click` / `observe-act-exclude` ladder instead of being routed to
the submit-only locator.
**Reporter:** downstream auto-apply consumer.
**Relationship:** refinement of the phantom-click fix shipped in 1.6.2 (see
`recon-submit-step-phantom-click-bug.md`). The core fix is correct and working — this is about its
*scope*.

---

## Summary

The 1.6.2 phantom-click short-circuit is **not gated on whether the current step is a submit action**.
It triggers on **any** attempt-1 phantom click, and unconditionally:

1. **skips attempts 3 & 4** (`structured-click`, `observe-act-exclude`), and
2. routes to attempt 2 = the **deep-submit-locator**, which is submit-specific.

On a genuine submit step this is exactly right (it's the whole point of the fix). But on a **non-submit**
control — e.g. a radio/checkbox screening question — the deep-**submit**-locator structurally cannot
resolve the target (it ranks *submit-shaped* candidates only, and deliberately excludes non-submit
controls), so attempt 2 is a guaranteed no-op, and the very techniques that *could* click a radio
(`structured-click` / `observe-act-exclude`) have already been skipped.

## Root cause (1.6.2 source)

`flow-runner.ts` phantom-click short-circuit (dist `flow-runner.js:~957-968`):

```js
if (phantomClickAfterAttempt1 === true &&
    (technique === "observe-act" ||
     technique === "structured-click" ||
     technique === "observe-act-exclude")) {
  return {
    skip: true,
    reason: "attempt 1 was a phantom click ... escalating to the deep submit-control locator",
  };
}
```

The condition keys only on `phantomClickAfterAttempt1` + technique name. There is **no check that the
step is a submit-shaped instruction** before it commits to the submit-locator path and drops the
non-submit fallbacks. The skip `reason` itself reveals the mismatch — it is written entirely in terms
of "the deep submit-control locator," yet it fires for every control type.

## Observed behavior (run `20260719-071658-a15e`)

Two optional radio steps, both phantomed and both routed down the submit path:

- **step 38** — `Click the 'No' label for 'Are you currently a Contingent Worker?' (optional)`
- **step 40** — `Click the 'No' label for 'Have [you...]' (optional)`

For each:
```
attempt 1 (act-string)          → phantom click detected
attempt 2 (deep-submit-locator) → produced no observable effect   (radio ≠ submit control)
attempt 3 (structured-click)    → SKIPPED ("...escalating to the deep submit-control locator")
attempt 4 (observe-act-exclude) → SKIPPED (same)
attempt 5 (llm-rephrase)        → ~LLM latency, then step skipped (optional, no candidates)
```
Net: ~90s burned per step on a path that cannot succeed, then the step is skipped because it's optional.

## Impact

- **Optional non-submit steps:** harmless outcome (they skip anyway), but ~90s wasted each; across a
  large form with many optional screening radios this adds up.
- **Required non-submit steps (the real risk):** a required radio/checkbox that phantom-clicks on
  attempt 1 would now have attempts 3 & 4 skipped and attempt 2 spent on the wrong (submit) locator —
  i.e. the fallbacks most likely to click it are removed. For that case 1.6.2 is **worse than 1.6.1**,
  which would have run `structured-click` / `observe-act-exclude`.
- The phantom classifier itself is fine; it's the *escalation target* that's mis-scoped.

## Suggested fix (report only — Barnacle's call)

Gate the phantom short-circuit on whether the step is a **submit-shaped action**:

- If the step is a submit action → keep current behavior (skip 3 & 4, go to deep-submit-locator).
- If the step is **not** a submit action → still record the phantom (attempt 1 was a no-op) but **do
  not** skip `structured-click` / `observe-act-exclude`, and don't route to the submit-only locator.
  A general "deep control locator" (shadow-piercing but not submit-restricted) would be the ideal
  attempt-2 for non-submit phantoms, if one exists; otherwise fall through to the normal 3 → 4 → 5
  ladder.

The submit-vs-not signal likely already exists (the deep-submit-locator's own candidate ranking, and
the step instruction text), so the gate is a scoping condition rather than new machinery.

## Notes

- Does **not** block our investigation — these are optional screening steps; the run continues toward
  the actual submit step, which is the deep-submit-locator's intended (and correct) target.
- Two prior related reports in this dir: `recon-temp-dir-namespacing-bug.md` (fixed in 1.6.2) and
  `recon-submit-step-phantom-click-bug.md` (fixed in 1.6.2 — this doc refines the scope of that fix).
- This report: fixed in 1.6.3 (commit d3a22fb) — see **Status** above.
