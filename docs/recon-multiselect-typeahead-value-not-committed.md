# Recon: multiselect-typeahead prompt value never commits (focused probe finds it 0 candidates → primitive bypassed → view-swap false-pass)

**Filed:** 2026-08-18 · **Barnacle:** 1.12.2 · **Reporter:** cvshealth plugin build
**Site:** `cvshealth.wd1.[ats-host]` (an ATS-hosted Candidate Experience wizard).
**Evidence:** `src/scraper/multiselect-typeahead-evidence.test-helper.ts`
(nested-container markup captured from `source-multiselect-widget.html`, `source-commit-summary.txt`, two `step10-source-*.txt`).
Run dirs: `/tmp/recon/20260818-085324-5f82/` (run 4), `/tmp/recon/20260818-091150-43a3/` (run 5).

## First — the 1.12.2 fix is a big win

`tryPromptSelectorPrimitive` (1.12.2) made the CVS flow tractable: recon now
creates the account, fills My Information, and drives the full 7-step wizard —
`country`, `countryRegion` (State), and `phoneType` prompt selectors all **commit their
values** (they appear in the section-save POST bodies), and each wizard page advances via
real `Save and Continue` POSTs (`verifiedBy=network`). This is a large step past the prior
two blockers. Thank you.

## The remaining problem: ONE widget shape never commits

The **"How Did You Hear About Us?"** field (`source`) is the sole
field that blocks the final Submit. At the Review→Submit step the ATS re-validates all
sections, finds `source` empty+required (`aria-invalid` on its `promptIcon`), and bounces
the wizard back to "step 1 of 7: My Info" with no Submit button. Reproduced on the final
Submit of both run 4 and run 5.

### What makes `source` different

It is a **multiselect typeahead** — the captured markup (see
`src/scraper/multiselect-typeahead-evidence.test-helper.ts`) shows a nested
"multiselect" widget wrapping a "selectinput" filter field (chip-style: click
to focus → type to filter → click the option). The prompt selectors that DO
commit (`country`, `countryRegion`, `phoneType`) are single-value variants
with a different structure.

### The mechanism (from the step-10 logs, identical across runs)

```
step 10/34: focused probe found 0 candidates but unfocused observe found 30 — treating as present (let cascade resolve)
step 10/34 succeeded on attempt 1 via act-string (network=false url=false dom=true verifiedBy=view-swap)
```

- **Focused probe returns 0 candidates** for the `source` widget → `tryPromptSelectorPrimitive`
  is **never invoked** on it (the primitive needs the probe to surface the widget). So the
  1.12.2 typeahead handling — including `PROMPT_SEARCH_SELECTORS`' type-to-filter path,
  which is exactly what this widget needs — does not get a chance to run.
- The generic **`act-string`** path runs instead, opens the dropdown (a
  `GET .../values/sources/sources` fires, loading the 6 options), and is credited
  **`verifiedBy=view-swap`** — the popup appearing counts as success — **without any option
  being typed/selected**. The `POST .../source` body stays `{}` (empty) for the whole run.

### Controlled reproduction — label ruled out

`source` never committed across 3 runs, including one with a **confirmed-valid** option
label (`source-commit-summary.txt`):

| run | label used | in live options list? | committed? |
|-----|-----------|----------------------|-----------|
| 6fa2 | "Company Website" | no (my error) | NO |
| 5f82 | "Internet - Job Boards/Search Engines" | no (my error) | NO |
| **43a3** | **"Job Boards"** | **YES** | **NO** |

(Live options, `GET values/sources/sources`: Advertising, CVS, Job Boards, Job Fair,
Military, Networking/Professional Organization.) Run 43a3 used a real option and still
produced an empty `/source` POST — so a wrong label is **not** the cause of the final
failure.

## What I could NOT fully isolate (honest caveat)

My flow step is phrased as one instruction: *"open the 'source' prompt selector, then
select the option 'Job Boards' from the popup list."* I did **not** get to test whether
splitting it into explicit *"click to focus the multiselect"* → *"type 'Job Boards'"* →
*"click the 'Job Boards' option"* sub-steps changes the outcome. So I can't 100% rule out
that a differently-phrased flow would drive it. **However**, the focused-probe-0 result
means the primitive is bypassed *before* phrasing matters, and `view-swap` passing an
un-committed open is a real false-positive regardless — which is why I'm reporting rather
than just re-authoring.

## Requested

1. Make the **focused probe surface the multiselect-typeahead** widget so
   `tryPromptSelectorPrimitive` actually runs on it (it already lists these selectors in
   `PROMPT_TRIGGER_SELECTORS`; the gap is the probe returning 0 candidates upstream).
2. `view-swap` should **not** verify a prompt/typeahead interaction as success when the
   widget's committed value is still empty (the primitive's value-readback would catch
   this — the generic act-string fallback currently doesn't gate on it).

## What this blocks

The `cvshealth` plugin can now be driven end-to-end EXCEPT the `source` field, which is
required for final submit — so recon can't yet capture a completed submission. Per the
plugin-repo directive I'm **stopping and waiting** rather than working around it. The flow
file (`nursefly/autoapply:src/sites/cvshealth/recon-flow.json`) is otherwise correct and
ready to re-run.

(Separately, one Voluntary-Disclosures Gender prompt hit a phantom-click-exhaust in run 5
— barnacle's own phantom detector fired and all 5 techniques incl. trusted CDP click
found no observable effect. It's optional so it replanned past it; likely the same
multiselect-widget family. Mentioning for context, not as a separate ask.)
