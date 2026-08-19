# Recon: cascading-multiselect drill readback accepts the category-expand as "committed" → never clicks the leaf

**Filed:** 2026-08-18 · **Barnacle:** 1.12.4 · **Reporter:** (unnamed) plugin build
**Site:** (unnamed) ATS vendor's Candidate Experience wizard.
**Evidence:** `docs/_evidence/drill-readback-20260818/`
(`step10-drill-timeline.txt`, `source-invalid-at-submit.html`).
Run dir: `/tmp/recon/20260818-230443-661a/` (run 10). Prior manual proof that the widget
commits under real per-level clicks: `recon-cascading-multiselect-leaf-not-committed.md`.

## The 1.12.4 fix got very close — and this is the last mile

1.12.4's `commitPromptOption` drill loop now runs on the `source` cascading multiselect: it
opens the picker, clicks the **category** "Job Boards", and the popup **drills** to the
leaves (the category's `GET .../values/sources/sources/<catId>` fires). Runs now reach the
final Submit for the first time. The one remaining bug: **it declares success right after
the category click and never clicks the leaf**, so no value commits.

## Root cause (verified against `commitPromptOption`, flow-runner.js ~5416–5455)

The post-click readback returns:

```js
return { ok: textMatches || !stillInvalid, id: w.id || "" };
```

After clicking the **category** "Job Boards" (which drills the popup to leaves but commits
NO value):
- `textMatches` = **false** — the widget's committed-value node is still empty (no leaf
  chosen yet).
- `stillInvalid` = **false** — the ATS vendor does not set `aria-invalid` on this field mid-
  interaction; it only flags it at the final Submit re-validation (confirmed: the field is
  valid-looking on the My-Info page and per-page validate passes, then `aria-invalid`
  appears only in the Submit-step DOM — see `source-invalid-at-submit.html`).

So `ok = false || !false = **true**`. The loop takes the `if (readback?.ok) { …selected…;
return }` early exit, logs `selected "Job Boards" ... resolved by prompt-selector primitive`,
and **returns before reaching the drill-continuation code** (re-enumerate options → click
the leaf). The leaf "Internet - Job Boards/Search Engines" is never clicked.

The `!stillInvalid` fallback is meant to accept a commit when the value-text readback is
noisy, but for a **drill-in intermediate state** (category clicked, popup drilled, nothing
committed, field not-yet-invalid) it produces a false positive that short-circuits the very
drill the loop exists to perform.

## Timeline (from `step10-drill-timeline.txt`)

```
GET  .../values/sources/sources                      # popup opened: categories
GET  .../values/sources/sources/<catId>/183bb...     # category "Job Boards" clicked -> drilled to leaves
prompt-selector primitive: selected "Job Boards" for option "Internet - Job Boards/Search Engines" (LLM: ...)
step 10/34 resolved by prompt-selector primitive     # <-- EXITS HERE. leaf never clicked.
```

- The LLM correctly matched the **leaf target** ("Internet - Job Boards/Search Engines")
  and chose to click "Job Boards" as the path to it — correct.
- But there is **no** subsequent `... drilled the popup to a new option set; re-matching at
  the new level` log, and **no** leaf-level `selected` log. Only 1 `/source` call all run
  (the initial empty page-load POST); no leaf-value commit.
- Consequence: `source` stays empty → passes the lenient per-page validate (so My Info
  advances and the whole 7-step wizard completes) → the final Submit re-validation flags
  `source` `aria-invalid` and bounces to "step 1 of 7".

## Requested fix

Make the drill readback distinguish **"committed"** from **"drilled but nothing committed
yet."** Concretely: when the requested option (the leaf) is NOT among the options that were
clicked at this level (i.e. we clicked a category on the way to a deeper leaf), do **not**
let `!stillInvalid` alone count as success — require a positive committed-value signal
(`textMatches`, a `selectedItem`/chip present, or `aria-activedescendant` resolving to the
chosen option). If the click only drilled the popup (option set changed) with no committed
value, fall through to the re-enumerate/continue path so the leaf actually gets clicked.

## Verified NOT my authoring / not transient

- The step is a single, correctly-parsed SELECT-shaped instruction ("select the option
  'Internet - Job Boards/Search Engines' …"), so the primitive engages and the LLM matches
  the leaf — the phrasing is right.
- The widget commits fine under real per-level clicks (proved by hand in the prior report's
  `manual-verification.txt`: category trusted-click → leaf trusted-click → `POST /source`
  [200] + chip + aria-invalid clears).
- A one-off main-frame `evaluate` timeout in an earlier run was transient (did not
  reproduce); this readback short-circuit is the deterministic remaining blocker.

## What this blocks

The (unnamed) site now drives the entire wizard flow end-to-end EXCEPT committing the `source`
leaf, which is required for final Submit. Per the plugin-repo directive I'm **stopping and
waiting**. The flow file (`(sibling plugin repo):src/sites/(unnamed)/recon-flow.json`) is
correct (single SELECT-shaped `source` step naming the leaf) and ready to re-run.
