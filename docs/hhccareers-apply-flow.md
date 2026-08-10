# hhccareers apply flow — captured from the live site (2026-08-10)

> Manually captured ground truth for the Phenom People → Oracle Taleo apply flow
> at `www.hhccareers.org` — the submission path `recon-browser` did not capture
> automatically (see
> [barnacle-report-recon-generate-phenom.md](./barnacle-report-recon-generate-phenom.md),
> FAILURE 1). Reference for a regression fixture.

Manual walkthrough of the real Phenom apply wizard (Playwright), capturing the
step sequence and the actual submission API.

**Employer:** Hartford HealthCare (page title "Nursing at Hartford Healthcare";
footer "© Copyright Hartford HealthCare"). The `HHK` prefix / `hf-hartford-footer`
widgets are Hartford's.

**ATS stack:** **Phenom People** front-end (CareerConnect / applyStudio) →
**Oracle Taleo** backend. Every apply call carries `ats: "TALEO"`,
`applyAtsSource: "TALEO"`, `applySource: "applyStudio"`. Tenant / `refNum` =
**`HHKHHEUS`**.

## Entry

- Job page: `https://www.hhccareers.org/us/en/job/<ID>EXTERNALENUS/<slug>`
- **Apply Now** → `https://www.hhccareers.org/us/en/apply?jobSeqNo=<ID>EXTERNALENUS`
- The apply SPA redirects to `?step=1&stepname=personalInformation` and runs an
  **8-step wizard** (stepper visible the whole time):

  1. **Personal Information** (`personalInformation`)
  2. **Work Experience** (`workExperience`) — "highly encouraged", add-rows sub-form
  3. **Education** (`education`)
  4. **Employment** (`employment`)
  5. **Disability Self-Identify** (`disabilitySelfIdentify`)
  6. **Veterans Self-Identify** (`veteransSelfIdentify`)
  7. **Final Page** (`finalPage`)
  8. **Review and Submit** (`reviewAndSubmit`)

## Step-1 fields (personalInformation)

Text/select inputs (label → note): First Name\*, Middle Name, Last Name\*,
Personal Email\*, Mobile Phone Country Code\* (`USA_1`) + Mobile Phone\*, Country\*
(select, default United States), Address Line 1\*, Address Line 2, City\*, State\*
(select), Zip Code\*, "How did you hear about this opportunity?" (Agency/Broadcast/
Job Board/Personal Contact/Social Network/Other), and a required SMS/email consent
checkbox. Resume upload options at top: Dropbox / Indeed / OneDrive / **Upload
Resume** (resume required later in the flow).

## The real submission API — `POST /applySubmit`

All apply traffic is `POST https://www.hhccareers.org/applySubmit` with a JSON
body `{ "ddoKey": ..., "formData": {...} }`. Two `ddoKey`s:

- `applyGetReferences` — reference-data loads (country list `getCountry`, state
  list `getState` for a `countryCode`, `mcsProfile`). Codes are numeric:
  **country `1223` = United States**, **state `3081` = Connecticut**.
- **`applySubmit`** — the actual per-step save. **The wizard saves each step to
  the ATS as you Continue** (not a single final POST). Key `formData` fields
  captured on the Step-1 save:

  ```
  firstName, lastName, email, personalMobilePhone,
  country("1223"), address, city, state("3081"), zipCode, consent("1"),
  jobCategory("Nursing"), jobId("26158515"),
  jobSeqNo("HHKHHEUS26158515EXTERNALENUS"), jobTitle, jobLocation, jobCountry,
  stepNum("personalInformation"), stepIndex("1"),
  isFirstStep(true), isLastStep(false),
  apTxnId("<uuid, threads all steps>"),
  refNum("HHKHHEUS"), siteType("external"),
  ats("TALEO"), applySource("applyStudio"),
  username(=email), loginType("apply"), applyType("apply"),
  thankyouPageUrl("…/applythankyou?status=success&jobSeqNo=…&jobId=…"),
  hasDqQuestions("no"), hasPSQQuestions("no"),
  dqData:[ HHC_DQ_HealthCareExclusion_qid, HHC_DQ_LegallyAuthorizedUSA_qid,
           HHC_DQ_Sponsorship_qid ]   // screening questions, empty on step 1
  ```
  (There is also a large `eventData` analytics blob mirroring the fields — Phenom
  telemetry, not required for submission.)

### Success response envelope (per step)

```json
{"applySubmit":{"STATUS":"success","response":{
  "status":"success","statusCode":"SUCCESS",
  "statusMessage":"stepNum personalInformation submitted successfully",
  "stepNum":"personalInformation",
  "apTxnId":"…","username":"…",
  "mcsProfileData":{"candidateID":"<hash>","isAnonymous":true},
  "atsSpecificData":{ "resumeFileTypes":"doc,docx,pdf,rtf,txt",
    "thankYouEmailParams":{…}, "successMessage":"Successfully applied.", … }
}}}
```

- **`apTxnId`** returned each step ties the multi-step application together.
- **Resume constraints:** types `doc,docx,pdf,rtf,txt`; the UI error text says
  **< 1 MB**.
- **Final success signal:** redirect to
  `https://www.hhccareers.org/us/en/applythankyou?status=success&jobSeqNo=…&jobId=…`
  and `statusMessage` "Successfully applied." / a 24-hour processing message.

## Apply-config endpoints (tenant-scoped, GET)

`https://content-us.phenompeople.com/api/HHKHHEUS/<ddoKey>?locale=en_us&siteType=external&deviceType=desktop&payload=…`
— seen: `getRegionLocales`, `getPiiConsentConfig`. (This is the tenant path
`HHKHHEUS` the earlier `/api/apply/v2/jobs` probe lacked.)

## Capture method / safety

Driven with Playwright using the recon testmail address
(`…@inbox.testmail.app`). Filled Step 1 and clicked **Continue** to trigger the
`personalInformation` save (a per-step ATS write) — then **stopped**. Did **not**
complete the final Review-and-Submit step, so no full application was submitted.
Note: because Phenom saves each step server-side, the Step-1 save created an
**anonymous mcsProfile** candidate id in Taleo; no job application was finalized.

## Relation to the generated plugin

The submission path documented here is `POST /applySubmit` (per-step, threaded by
`apTxnId`, `ats:"TALEO"`, `refNum:"HHKHHEUS"`, numeric country/state codes from
`applyGetReferences`). The recon-generated `contract.ts`/`browser-flow.ts` instead
modeled the page-chrome `/widgets` calls — orthogonal to `/applySubmit` — as
detailed in
[barnacle-report-recon-generate-phenom.md](./barnacle-report-recon-generate-phenom.md)
(FAILUREs 2-4).
