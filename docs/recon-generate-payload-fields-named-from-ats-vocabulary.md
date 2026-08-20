# `recon:generate` names payload fields from the ATS's vocabulary, rejecting 100% of real calls

**Severity:** high — the generated plugin cannot serve a single production request, and every
offline gate passes, so nothing catches it before deploy.
**Status:** worked around by hand in an affected plugin; filing so the next regen doesn't
reintroduce it.

## What happened

`recon:generate` emitted this payload schema for a fictional site, `acme-jobs`:

```ts
const AcmeJobsPayloadSchema = ApplicantContactSchema.extend({
  Email: z.email(),
  ClickUrl: z.string().min(1),
  Answers: multipartJsonObject(z.record(z.string(), z.unknown())),
  AddressLine1: z.string(),   // ← from the ATS form label "Address Line 1"
  MobilePhone: z.string(),    // ← from the ATS form label "Mobile Phone"
});
```

`AddressLine1` and `MobilePhone` are **required** and are named after the *ATS form's* labels,
which recon observed. But the caller's vocabulary is different. The caller's own form-submission
helper appends:

```
JobId, BaseUrl?, ClickUrl?, TrackingUrl?, FirstName, LastName, Email,
Phone, AddressLine, City, State, PostalCode, Country, County,
Resume, ResumeContentType, ResumeFilename, ResumeBase64, Answers
```

There is no `MobilePhone` and no `AddressLine1` anywhere in that form. Both required fields are
therefore absent on **every** request, and Zod rejects with code 1002 before the flow runs.

Note the generator already extends `ApplicantContactSchema`, which *defines the correct names*
(`AddressLine`, `Phone`) two lines above. It then adds ATS-named duplicates of fields it
already has.

## This is a regression of a trap the ecosystem already documented

A prior fix for a different plugin carries a comment written after the same bug shipped, to the
effect of:

> Built on ApplicantContactSchema like every other plugin. This originally hand-rolled its own
> object naming fields after the ATS's own form labels ("Mobile Phone" → MobilePhone, "Address
> Line 1" → AddressLine1) — recon captures the ATS's vocabulary, which is not the caller's.
> Since the caller sends Phone/AddressLine, both fields were missing on every request and Zod
> rejected 100% of production runs with code 1002 before any flow ran.

Same two field names, same ATS-label origin, same failure. The generator reproduced it
mechanically.

## Why no gate caught it

`pnpm lint`, `typecheck`, the full test suite and the **boot check** all passed, and the plugin
merged. None of them exercise a real caller payload: the schema is internally consistent, it
just describes the wrong sender. This is worth noting because the boot check is otherwise this
repo's strongest gate.

## Suggested fix

When a discovered field's semantic role already exists in `ApplicantContactSchema`, reuse that
schema's field name instead of minting a new one from the observed label. A minimal alias table
over the ATS-vocabulary → caller-vocabulary mapping covers the common cases:

| observed label / automation-id | must map to |
|---|---|
| "Mobile Phone", "Phone Number", `phoneNumber` | `Phone` |
| "Address Line 1", `addressLine1` | `AddressLine` |
| "Zip", "Postal Code" | `PostalCode` |
| "Legal First Name", "Given Name" | `FirstName` |
| "Legal Last Name", "Surname", "Family Name" | `LastName` |

Stronger version: since `basePayloadSchemaExpr` always emits
`ApplicantContactSchema.extend({...})`, the generator could **refuse to add any `extend` key
whose role duplicates a base-schema field** and log what it collapsed. A field the caller never
sends should never be emitted as required — if recon genuinely discovers a required input with
no caller counterpart, that is a `needsUserInfo` case, not a new required payload key.

## Reproduction

Run `recon:generate` against any ATS whose form labels the address line as "Address Line 1" and
the phone as "Mobile Phone". Inspect the emitted `*PayloadSchema` for keys duplicating
`ApplicantContactSchema`'s.
