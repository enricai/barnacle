# Submission Reconciliation Runbook

> How to join a Barnacle run to its row in the Appcast CPA report. This is the
> operator runbook — the *what fields, what queries* companion to the concept
> guide in [telemetry-and-judging.md](./telemetry-and-judging.md#submission-envelope-sink),
> which explains *why* the sink is shaped the way it is.

**Audience:** the attribution/web team reconciling Appcast payment against
Barnacle's own submit + beacon-fire records, without re-parsing raw NDJSON by
hand every time.

---

## The reconciliation shape, in one paragraph

Appcast's CPA report already reconciles at the cohort level: the HCA hot path
launched 2026-07-14 and produced 693 successful applies through 7/26 (per prod
DB), and Appcast's paid `Applies` rows for HCA jobs over that same window carry
a **blank `vivclid` on ~85% of paid dollars** — yet the two sides still
reconcile at a ~27% paid rate in aggregate. That blank-`vivclid` row is the
**normal case for HCA, not an edge case** to special-case around. Any
per-run join recipe that only tries `vivclid` will silently miss most of the
paid rows for this cohort. Every recipe below tries `vivclid` first and falls
back to `jobReference` (`<empId>_<jid>`) + a date window when `vivclid` is
blank, because that fallback path is where most of the real matches are.

---

## Join-key table

These are the named, first-class fields on every reconciliation row — no
field here requires parsing `inboundPayload`. Full field-by-field reference:
[telemetry-and-judging.md § Submission-envelope sink](./telemetry-and-judging.md#submission-envelope-sink).

| Appcast CPA report column | Barnacle record field | Notes |
|---|---|---|
| `vivclid` (Appcast's applicant-level click ID) | `vivclid` | Nullable. Resolved from the inbound payload or its `TrackingUrl` query string by `extractVivclid` (`src/lib/reconciliation-keys.ts`). **Blank on ~85% of HCA paid dollars** — do not treat presence as guaranteed. |
| Job cohort / site | `siteId` | The plugin that handled the request — always present, the cohort dimension for roll-ups. |
| Job reference (Appcast's `<empId>_<jid>`) | `jobReference` | Nullable, but populated far more reliably than `vivclid`. Resolved by `extractJobReference` the same way — explicit field, then `empId`/`jid` pair, then the same pair in `TrackingUrl`'s query string. |
| Apply outcome | `status` | `"submitted"` or `"error"` — whether Barnacle's own submit attempt succeeded, distinct from beacon fire. |
| Conversion / beacon fire | `beaconStatus` | `"fired"`, `"failed"`, or `"not_fired"` — a dimension separate from `status`. `"not_fired"` means a submit row exists with no matching beacon line at all. |
| Apply timestamp | `ts` | ISO-8601. Use with `from`/`to` to bound a CPA report's date window. |
| Correlation ID (internal) | `requestId` | Joins a submit row to its beacon row; not an Appcast field, but useful when cross-referencing app logs. |

`vivclid`/`jobReference`/`siteId` all appear on both `"submit"` and
`"beacon"` sink lines and on every row `GET /v1/submissions` returns.

---

## Reading the sink: HTTP route vs. raw NDJSON

Two ways to run these recipes:

- **`GET /v1/submissions`** (authenticated) — the queryable read path. Prefer
  this; it left-joins beacon rows onto submit rows and paginates for you.
  Querystring params: `vivclid`, `siteId`, `jobReference`, `status`,
  `beaconStatus` (`fired` / `failed` / `not_fired`), `from`/`to` (ISO-8601,
  inclusive), `limit` (max `1000`), `offset`. Schema:
  `src/api/schemas/submissions.ts`.
- **Raw NDJSON** (`.barnacle/submissions.ndjson`, path from
  `SUBMISSIONS_NDJSON_PATH`) via `jq` — the fallback when you need a shape the
  route doesn't expose yet (e.g. `inboundPayload`/`auditPayload`), or when you
  don't have network access to a running Barnacle instance.

All recipes below were run against a locally generated sample sink (same
shape as production, 5 submits across two `siteId` cohorts + 4 beacon lines)
with a real Barnacle instance on `localhost:3971` and `DEV_BYPASS_AUTH=true`,
and the output is shown verbatim.

Sample rows used (`kind: "submit"` / `kind: "beacon"` lines, abbreviated):

| `requestId` | `siteId` | `vivclid` | `jobReference` | `status` | beacon |
|---|---|---|---|---|---|
| `req-1001` | `hca` | `vc-9f3a21` | `4471_88213` | `submitted` | `fired` |
| `req-1002` | `hca` | _(blank)_ | `4471_88214` | `submitted` | `fired` |
| `req-1003` | `hca` | _(blank)_ | `4471_88215` | `submitted` | _(no beacon line)_ |
| `req-1004` | `hca` | `vc-1120bb` | `4471_88216` | `error` | _(no beacon line)_ |
| `req-1005` | `christus` | _(blank)_ | `5502_11029` | `submitted` | `fired` |
| `req-1006` | `hca` | _(blank)_ | `4471_88217` | `submitted` | `failed` |

Replace the sample host/port and query values with your own before running
these against a real environment.

---

## Recipe 1 — per-run lookup by `vivclid`

Use when the CPA report row *does* carry a `vivclid` (the ~15% case for HCA,
the common case for other cohorts).

```bash
curl -s "http://localhost:3971/v1/submissions?vivclid=vc-9f3a21" \
  -H "Authorization: Bearer $BARNACLE_API_KEY" | jq .
```

Output:

```json
{
  "status": {
    "httpStatus": "OK",
    "dateTime": "2026-07-27T00:51:31Z",
    "details": []
  },
  "submissions": [
    {
      "siteId": "hca",
      "requestId": "req-1001",
      "vivclid": "vc-9f3a21",
      "jobReference": "4471_88213",
      "status": "submitted",
      "errorMessage": null,
      "durationMs": 8213,
      "ts": "2026-07-20T14:02:11.000Z",
      "beaconStatus": "fired",
      "trackingUrl": "https://trk.appcast.io/click?vivclid=vc-9f3a21&empId=4471"
    }
  ],
  "total": 1
}
```

### Blank-`vivclid` fallback: same recipe, keyed on `jobReference`

This is the path that matters for the dominant HCA case. When the CPA row's
`vivclid` is blank, join on `jobReference` (`<empId>_<jid>`, composed from the
CPA report's own employer/job identifiers) instead, optionally narrowed with
`from`/`to` to the CPA report's date window if more than one run shares a
`jobReference`:

```bash
curl -s "http://localhost:3971/v1/submissions?jobReference=4471_88214" \
  -H "Authorization: Bearer $BARNACLE_API_KEY" | jq .
```

Output:

```json
{
  "status": {
    "httpStatus": "OK",
    "dateTime": "2026-07-27T00:51:34Z",
    "details": []
  },
  "submissions": [
    {
      "siteId": "hca",
      "requestId": "req-1002",
      "vivclid": null,
      "jobReference": "4471_88214",
      "status": "submitted",
      "errorMessage": null,
      "durationMs": 7650,
      "ts": "2026-07-20T15:10:03.000Z",
      "beaconStatus": "fired",
      "trackingUrl": "https://trk.appcast.io/click?empId=4471&jid=88214"
    }
  ],
  "total": 1
}
```

---

## Recipe 2 — cohort roll-up by `siteId`

Reproduces the cohort-level check attribution already trusts (applies-per-site,
plus the blank-`vivclid` rate that made this runbook necessary) at the
per-run level, so a cohort total can be traced back to its constituent runs.

```bash
curl -s "http://localhost:3971/v1/submissions?limit=1000" \
  -H "Authorization: Bearer $BARNACLE_API_KEY" \
  | jq '[.submissions[] | select(.status == "submitted")]
        | group_by(.siteId)
        | map({siteId: .[0].siteId, applies: length, blankVivclid: (map(select(.vivclid == null)) | length)})'
```

Output:

```json
[
  {
    "siteId": "christus",
    "applies": 1,
    "blankVivclid": 1
  },
  {
    "siteId": "hca",
    "applies": 4,
    "blankVivclid": 3
  }
]
```

(3 of 4 `hca` applies in this sample carry a blank `vivclid` — consistent
with the ~85%-of-paid-dollars figure this runbook is built around; the sample
is small enough that the exact percentage won't match, only the shape.)

For a single cohort's raw rows (e.g. to hand-verify against the CPA report
row by row), filter server-side with `siteId` instead of grouping client-side.
Note this returns every row for the cohort regardless of `status`, so the
count includes errored submits (not eligible for a CPA match) alongside the
4 successful applies counted above:

```bash
curl -s "http://localhost:3971/v1/submissions?siteId=hca&limit=1000" \
  -H "Authorization: Bearer $BARNACLE_API_KEY" | jq '.submissions | length'
```

Output:

```
5
```

---

## Recipe 3 — submitted but the beacon did not fire

The conversion/beacon-fire dimension is `beaconStatus`, distinct from submit
`status` — a row can be `status: "submitted"` and still show
`beaconStatus: "not_fired"` (no beacon line ever arrived) or
`beaconStatus: "failed"` (the tracking-click navigation itself errored). Both
are candidates for "why didn't this apply get credited," but `"not_fired"` is
the one worth alerting on — it means the beacon fire never happened at all,
not just that it failed.

```bash
curl -s "http://localhost:3971/v1/submissions?status=submitted&beaconStatus=not_fired" \
  -H "Authorization: Bearer $BARNACLE_API_KEY" | jq .
```

Output:

```json
{
  "status": {
    "httpStatus": "OK",
    "dateTime": "2026-07-27T00:51:42Z",
    "details": []
  },
  "submissions": [
    {
      "siteId": "hca",
      "requestId": "req-1003",
      "vivclid": null,
      "jobReference": "4471_88215",
      "status": "submitted",
      "errorMessage": null,
      "durationMs": 9021,
      "ts": "2026-07-21T09:44:57.000Z",
      "beaconStatus": "not_fired",
      "trackingUrl": null
    }
  ],
  "total": 1
}
```

`req-1004` (an `error`-status submit) is correctly excluded — a failed
apply was never eligible to fire a beacon in the first place, so it shouldn't
count toward "submitted but the beacon did not fire."

---

## `jq` fallback: reading raw NDJSON directly

When you can't reach a running Barnacle instance, or you need
`inboundPayload`/`auditPayload` that `GET /v1/submissions` deliberately omits,
read `.barnacle/submissions.ndjson` directly. `"submit"` lines written before
`kind` existed have no `kind` field at all (see
[telemetry-and-judging.md](./telemetry-and-judging.md#submission-envelope-sink));
the `select` below tolerates both. Mirrors the jq-recipe style already used
for `calls.ndjson` in [README.md](../README.md#tailing-call-samples-with-jq).

```bash
# Per-run lookup by vivclid (only matches kinded or legacy-unkinded submit lines)
jq -c 'select(.kind == "submit" or (.kind == null and has("inboundPayload")))
       | select(.vivclid == "vc-9f3a21")' .barnacle/submissions.ndjson
```

Output (against the same sample sink):

```
{"kind":"submit","siteId":"hca","requestId":"req-1001","vivclid":"vc-9f3a21","jobReference":"4471_88213","inboundPayload":{"empId":"4471","jid":"88213","vivclid":"vc-9f3a21"},"status":"submitted","auditPayload":{"confirmationId":"CNF-1001"},"errorMessage":null,"durationMs":8213,"ts":"2026-07-20T14:02:11.000Z"}
```

```bash
# Blank-vivclid submit rows for one siteId — the dominant HCA path
jq -c 'select((.kind == "submit" or (.kind == null and has("inboundPayload")))
              and .siteId == "hca" and .vivclid == null)' .barnacle/submissions.ndjson
```

Output:

```
{"kind":"submit","siteId":"hca","requestId":"req-1002","vivclid":null,"jobReference":"4471_88214", ...}
{"kind":"submit","siteId":"hca","requestId":"req-1003","vivclid":null,"jobReference":"4471_88215", ...}
{"kind":"submit","siteId":"hca","requestId":"req-1006","vivclid":null,"jobReference":"4471_88217", ...}
```

```bash
# Submitted-but-beacon-not-fired, computed by hand: submit requestIds with no matching beacon line
jq -s '
  [.[] | select(.kind == "submit" or (.kind == null and has("inboundPayload")))] as $submits |
  [.[] | select(.kind == "beacon") | .requestId] as $beaconIds |
  [$submits[] | select(.status == "submitted")
              | select(.requestId as $r | $beaconIds | index($r) | not)
              | {requestId, siteId, jobReference, vivclid, ts}]
' .barnacle/submissions.ndjson
```

Output:

```json
[
  {
    "requestId": "req-1003",
    "siteId": "hca",
    "jobReference": "4471_88215",
    "vivclid": null,
    "ts": "2026-07-21T09:44:57.000Z"
  }
]
```

Same single row the HTTP recipe (Recipe 3) returned — the NDJSON fallback and
the read route agree, as expected since the route is built on the same
folding logic (`readReconciliationRows`, `src/lib/telemetry/submission-reader.ts`).

---

## File map

| Concern | File |
|---|---|
| Join-key extraction (`vivclid`/`jobReference`) from an inbound payload | `src/lib/reconciliation-keys.ts` |
| Submit-record + beacon-event schemas | `src/lib/telemetry/reconciliation-record.ts` |
| Sink read path (folds beacon onto submit by `requestId`) | `src/lib/telemetry/submission-reader.ts` |
| Filter/sort/paginate layer | `src/lib/telemetry/submission-query.ts` |
| `GET /v1/submissions` route + querystring/response schemas | `src/api/routes/submissions.ts`, `src/api/schemas/submissions.ts` |
| Concept guide (why the sink is shaped this way) | [telemetry-and-judging.md](./telemetry-and-judging.md#submission-envelope-sink) |
