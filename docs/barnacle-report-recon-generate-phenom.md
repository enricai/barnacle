# recon/generate failure report — Phenom apply site (hhccareers)

> Failure report for the `recon-browser` → `recon:generate` pipeline on
> `@enricai/barnacle@1.7.3`, from a run against a Phenom People front-end →
> Oracle Taleo backend apply site (`www.hhccareers.org`). Records what the
> pipeline did wrong; the captured ground truth lives in
> [hhccareers-apply-flow.md](./hhccareers-apply-flow.md). No remediation is
> proposed here.

**Engine:** `@enricai/barnacle@1.7.3`
**Date:** 2026-08-10
**Scenario:** the pipeline was run to scaffold a new site plugin for a **Phenom
People** front-end → **Oracle Taleo** backend apply site (`www.hhccareers.org`,
employer Hartford HealthCare). This is the first Phenom-fronted target; prior
targets in the reporting consumer repo are Talemetry, Oracle/Taleo direct, and
appcast.

---

## Summary of failures

The pipeline exited 0 on every step yet produced a non-functional plugin. Two
independent failures, one per tool:

1. **`recon-browser` with no `--flow` captured only the landing page.** It never
   walked the apply wizard; `replays/`, `aux/`, and `step-failures/` were left
   empty, and it still logged `recon complete` and exited 0.
2. **`recon:generate` treated that apply-less capture as a valid "submission
   flow"** and emitted a plugin modeling the site's page-chrome bootstrap calls
   (`POST /widgets`) as the application submission — a ~5,000-line `contract.ts`, an
   empty-`FLOW_STEPS` browser fallback, and a dangling reference to a
   `recon-flow.json` it never wrote.

The real apply flow was reachable by hand in one click ("Apply Now"); the captured
ground truth is in [hhccareers-apply-flow.md](./hhccareers-apply-flow.md).

The [Observed failures](#observed-failures) section breaks these two roots into six
findings — FAILUREs 3-4 are the concrete symptoms of the emitted plugin (root #2),
and FAILUREs 5-6 are minor/cosmetic.

One item initially suspected as a defect (the generated `bottleneck` import) turned
out **not** to be an engine bug — see
[Not engine defects (consumer-side)](#not-engine-defects-consumer-side).

---

## Repro

```bash
# 1. Capture — no --flow supplied
recon-browser.js \
  --url 'https://www.hhccareers.org/us/en/job/HHKHHEUS26158515EXTERNALENUS/Registered-Nurse-RN-Post-Anesthesia-Care-Unit' \
  --allocate-email APPLICANT_EMAIL \
  --provider browserbase

# 2. Generate from that capture
recon-generate.js \
  --vocabulary <consumer repo>/src/recon/ats-vocabulary.ts \
  --site-id hhccareers \
  --run-dir /tmp/recon/<runId>
```

Both exit 0. Step 1 logs `recon complete — 26 captures written`; step 2 logs
`generating plugin for hhccareers (submission flow, 3 steps, …)` and `done`.

---

## Observed failures

### FAILURE 1 — `recon-browser` with no `--flow` captures only landing-page traffic and reports success

**Severity:** high (silent — the capture looks usable but is not).

With no `--flow`/`--flow-file`, the run captured **26 requests, all tagged
`home`**: the Phenom landing page, its CDN assets, three `POST /widgets` bootstrap
calls, and tracking scripts (`phenomtrack.min.js`, `gtm.js`). The run dir's
`replays/`, `aux/`, and `step-failures/` are **all empty**. No Apply click, no form
fill, no submit was performed.

The step-execution engine is present and functional — with a `--flow`, the same
binary drives a wizard via `executeStepWithHealing`, per-step replan budget,
`waitForSpaReady`, submit verification, and DOM dumps. With **zero steps** supplied
it performs the initial `goto` and stops, and the terminal log (`recon complete`)
reads as success. `flow_steps=0` appears only as an easily-missed INFO line.

### FAILURE 2 — `recon:generate` accepts an apply-less run dir and reports a fabricated "submission flow"

**Severity:** high (silent; cascades into FAILUREs 3-4).

With `replays/` and `aux/` empty, generate still logged `generating plugin for
hhccareers (submission flow, 3 steps, …)`. The "3 steps" are the three
landing-page `POST /widgets` bootstrap calls — not an application. No guard fired
on the empty `replays/`/`aux/`.

### FAILURE 3 — generated `contract.ts` transcribes the entire page-chrome widget JSON as a literal Zod schema (~5,000 lines)

**Severity:** high (unusable, unmaintainable output).

`executeHttp` issues three `POST {BaseUrl}/widgets` calls and validates each
against a giant inline `z.object({...})` mirroring Phenom's
`canvasGetWidgetContent` response — hundreds of nested fields for menu labels, the
candidate-login widget copy, job-alert i18n strings, and build-specific
`hf-two-row-header$$z4HDz3nS`-style header variants and widget IDs (`zk5Thu`,
`9VrWMb`, …). None of it is a submission; it is static site chrome, and it would
break on any content/layout change. The emitted `contract.ts` is ~5,000 lines
(the exact count varies per regeneration).

### FAILURE 4 — generated `browser-flow.ts` is an empty stub and references a `recon-flow.json` that was never written

**Severity:** medium.

`FLOW_STEPS` is `[]` with `// TODO: add flow steps from
src/sites/hhccareers/recon-flow.json`, and the extract schema is a
`{ extraction: z.string() }` placeholder — but `recon-flow.json` was **never
emitted** (absent from the output dir). The browser fallback is inert and points at
a non-existent source-of-truth file. Generate wrote the stub and the dangling
pointer silently rather than erroring.

### FAILURE 5 (minor) — required resume fixture missing only surfaces as a WARN

`upload fixture not loaded from src/testing/fixtures/resume.pdf: ENOENT … upload
primitive will fall through`. The target apply flow's submit step requires a resume
(Phenom/Taleo: doc/docx/pdf/rtf/txt, <1 MB); the missing fixture is reported only
as a WARN and the run proceeds.

### FAILURE 6 (minor, cosmetic / log-only) — completion log names the wrong file and contradicts the emitted `index.ts`

The compiled-module emit path's final log is
(`recon-generate.ts:3731`):
`done — review <outDir>/, then register in src/plugins/loader.ts`. Two problems:

- **Wrong file.** Built-in plugins register in `BUILTIN_SITE_PLUGINS`
  (`src/plugins/discover.ts:53`), not `src/plugins/loader.ts` (which is the
  site-agnostic route/dispatch layer). So the log names the wrong file even for a
  built-in.
- **Self-contradiction.** The `index.ts` the same generator emits (template at
  `recon-generate.ts:3208-3209`) says *"point BARNACLE_PLUGINS at the compiled
  module — no core edits required."* The completion log tells the operator to make a
  core edit. One tool, two opposite instructions.

Harmless to runtime, but misleading — an out-of-tree plugin (the documented path)
registers via `BARNACLE_PLUGINS`, never by editing a core file.

---

## Not engine defects (consumer-side)

One item was initially suspected during triage but verified against barnacle's
`CLAUDE.md` and `src/scripts/recon-generate.ts` to be **correct, by-design
behavior**, not a pipeline bug. Recorded here so it is not re-filed:

- **Generated `bottleneck` / `zod/v4` imports are correct.** `bottleneck` is a
  first-class barnacle dependency (`package.json` `^2.19.5`) used by
  `createHttpClient` for throttling, and `zod/v4` is the mandated import for plugin
  authors (CLAUDE.md). The generator emits both intentionally
  (`recon-generate.ts:2709,2772`) and its generated header already instructs the
  operator to `pnpm add bottleneck zod` (`recon-generate.ts:2767`).
  **Mechanism of the load failure (measured):** `bottleneck` ships transitively with
  the engine and the engine resolves it fine, but pnpm's isolated `node_modules`
  layout does **not** hoist a dependency's transitive dep to the consumer root, so a
  bare `import "bottleneck"` from the generated plugin throws `ERR_MODULE_NOT_FOUND`
  (a classic pnpm phantom-dependency). **Resolution:** the consumer declares
  `bottleneck` (matching the engine's `^2.19.5`; done in nursefly/autoapply#107);
  `zod/v4` already resolves via `zod@3.25.x`. This is a consumer dependency gap, not
  an engine fault — though the
  barnacle team may wish to consider whether the generator should emit an
  engine-mediated limiter rather than a bare `bottleneck` import, so operators need
  no extra dependency. (Filed as consideration, not a defect.)

**Coverage note:** this run exercised only the compiled-module emit path. The
generator also emits a **config-only `*.plugin.json`** manifest
(`recon-generate.ts:3665`, loadable via `BARNACLE_PLUGINS` / `BARNACLE_PLUGINS_CONFIG_DIR`
with no compile step); that path was not tested here.

---

## Ground truth — the real apply flow (reference for a regression fixture)

Captured by hand (Playwright) from a live posting, stopping before final submit —
i.e. what FAILURE 1 did not capture automatically.

- **Entry:** job page "Apply Now" →
  `https://www.hhccareers.org/us/en/apply?jobSeqNo=<ID>EXTERNALENUS`
  → SPA redirects to `?step=1&stepname=personalInformation`.
- **8-step wizard:** `personalInformation`, `workExperience`, `education`,
  `employment`, `disabilitySelfIdentify`, `veteransSelfIdentify`, `finalPage`,
  `reviewAndSubmit`.
- **Real submission API:** `POST https://www.hhccareers.org/applySubmit`, body
  `{ "ddoKey": ..., "formData": {...} }`, two `ddoKey`s:
  - `applyGetReferences` — reference-data loads (`getCountry`, `getState`,
    `mcsProfile`); numeric codes (US country = `1223`, CT state = `3081`).
  - **`applySubmit`** — the actual save, **fired once per wizard step** (not a
    single final POST), threaded by a stable `apTxnId` UUID. Step-1 `formData`
    fields: `firstName, lastName, email, personalMobilePhone, country, address,
    city, state, zipCode, consent, jobCategory, jobId, jobSeqNo, jobTitle,
    stepNum, stepIndex, isFirstStep, isLastStep, apTxnId, refNum("HHKHHEUS"),
    siteType("external"), ats("TALEO"), applySource("applyStudio"), username,
    thankyouPageUrl, dqData[…]`. (Plus a large `eventData` analytics blob mirroring
    the fields — Phenom telemetry, not required for submission.)
- **Success envelope (per step):**
  `{"applySubmit":{"STATUS":"success","response":{"status":"success",
  "statusCode":"SUCCESS","statusMessage":"stepNum <name> submitted successfully",
  "apTxnId":…,"mcsProfileData":{"candidateID":…}, …}}}`.
- **Final success signal:** redirect to
  `/us/en/applythankyou?status=success&jobSeqNo=…&jobId=…`.
- The `/widgets` calls the generator modeled are **page chrome only** — orthogonal
  to `/applySubmit`.

**Repro caution:** `/applySubmit` writes each step **server-side into Taleo** as the
wizard advances (an anonymous `mcsProfile` candidate is created on step 1), so a
capture/fixture should stop before `reviewAndSubmit` to avoid finalizing real
applications.
