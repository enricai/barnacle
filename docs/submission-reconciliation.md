# Submission Reconciliation Runbook

> How to join a Barnacle run to a row in your own attribution provider's
> report. This is the operator runbook — the *what fields, what queries*
> companion to the concept guide in
> [telemetry-and-judging.md](./telemetry-and-judging.md#submission-envelope-sink),
> which explains *why* the sink is shaped the way it is.

**Audience:** whoever owns reconciling attribution-provider payment against
Barnacle's own submit + beacon-fire records, without re-parsing raw NDJSON by
hand every time.

Field-by-field reference for the generic (site-agnostic) rows this route
returns: [telemetry-and-judging.md § Submission-envelope sink](./telemetry-and-judging.md#submission-envelope-sink).
For a worked example with real join-key recipes for a specific attribution
provider, see that plugin's own docs — this runbook only covers the fields
core actually knows about.

---

## Fields every reconciliation row carries

| Field | Meaning |
|---|---|
| `siteId` | The plugin that handled the request — the cohort dimension for roll-ups. |
| `requestId` | Joins a submit row to its beacon row; also useful when cross-referencing app logs. |
| `joinKeys` | Opaque `Record<string, unknown> \| null` — whatever the plugin's own `extractJoinKeys` hook resolved from the inbound payload (an attribution vendor's click ID, a job reference, or whatever that plugin's provider needs). Core does not know or validate its shape; `null` for a plugin with no `extractJoinKeys`, or when it resolved nothing for a given run. |
| `status` | `"submitted"` or `"error"` — whether Barnacle's own submit attempt succeeded, distinct from beacon fire. |
| `beaconStatus` | `"fired"`, `"failed"`, `"skipped"`, or `"not_fired"` — a dimension separate from `status`. A self-managing plugin (one that declares `extractJoinKeys`) is not locked to `"skipped"`: it can call `recordBeaconOutcome` to report the real outcome of the nav it drove itself, and a real `"fired"`/`"failed"` always wins the fold over `"skipped"` for the same run, regardless of arrival order. So `"skipped"` now means the plugin did not opt into self-recording that outcome — check `trackingUrl` to tell why: `null` means no usable `TrackingUrl` was ever present, a real URL means the plugin manages its own tracking nav and hasn't (yet, or ever) reported a `fired`/`failed` outcome for it. `"not_fired"` means a submit row exists with no matching beacon line at all (a beacon was applicable but never recorded an outcome). |
| `ts` | ISO-8601. Use with `from`/`to` to bound a report's date window. |

`joinKeys` and `siteId` appear on both `"submit"` and `"beacon"` sink lines
and on every row `GET /v1/submissions` returns.

---

## Reading the sink: HTTP route vs. raw NDJSON

Two ways to run these recipes:

- **`GET /v1/submissions`** (authenticated) — the queryable read path. Prefer
  this; it left-joins beacon rows onto submit rows and paginates for you.
  Querystring params: `siteId`, `requestId`, `status`, `beaconStatus`
  (`fired` / `failed` / `skipped` / `not_fired`), `from`/`to` (ISO-8601,
  inclusive), `limit` (max `1000`), `offset`. `joinKeys` is not filterable at
  this layer (core doesn't know its shape) — narrow with `siteId`/`requestId`
  first, then filter the response client-side. Schema:
  `src/api/schemas/submissions.ts`.
- **Raw NDJSON** (`.barnacle/submissions.ndjson`, path from
  `SUBMISSIONS_NDJSON_PATH`) via `jq` — the fallback when you need a shape the
  route doesn't expose yet (e.g. `inboundPayload`/`auditPayload`), or when you
  don't have network access to a running Barnacle instance, or you need to
  filter/join on a specific `joinKeys` field the route can't filter on.

All recipes below were run against a locally generated sample sink (same
shape as production, 5 submits across two `siteId` cohorts + 4 beacon lines)
with a real Barnacle instance on `localhost:3971` and `DEV_BYPASS_AUTH=true`,
and the output is shown verbatim.

Sample rows used (`kind: "submit"` / `kind: "beacon"` lines, abbreviated —
`joinKeys` here happens to carry a `vivclid`/`jobReference` pair, but the
route treats it as an opaque bag regardless of what's inside):

| `requestId` | `siteId` | `joinKeys` | `status` | beacon |
|---|---|---|---|---|
| `req-1001` | `acme` | `{vivclid: "vc-9f3a21", jobReference: "4471_88213"}` | `submitted` | `fired` |
| `req-1002` | `acme` | `{jobReference: "4471_88214"}` | `submitted` | `fired` |
| `req-1003` | `acme` | `{jobReference: "4471_88215"}` | `submitted` | _(no beacon line)_ |
| `req-1004` | `acme` | `{vivclid: "vc-1120bb", jobReference: "4471_88216"}` | `error` | _(no beacon line)_ |
| `req-1005` | `other-site` | `{jobReference: "5502_11029"}` | `submitted` | `fired` |
| `req-1006` | `acme` | `{jobReference: "4471_88217"}` | `submitted` | `failed` |

Replace the sample host/port and query values with your own before running
these against a real environment.

---

## Recipe 1 — cohort roll-up by `siteId`

Reproduces the cohort-level check attribution already trusts (applies-per-site)
at the per-run level, so a cohort total can be traced back to its constituent
runs.

```bash
curl -s "http://localhost:3971/v1/submissions?siteId=acme&limit=1000" \
  -H "Authorization: Bearer $BARNACLE_API_KEY" | jq '.submissions | length'
```

Output:

```
5
```

This returns every row for the cohort regardless of `status`, so the count
includes errored submits (not eligible for a downstream match) alongside
successful applies. Filter client-side by `status`/`beaconStatus`, or narrow
further with `from`/`to`.

---

## Recipe 2 — submitted but the beacon did not fire

The conversion/beacon-fire dimension is `beaconStatus`, distinct from submit
`status` — a row can be `status: "submitted"` and still show
`beaconStatus: "not_fired"` (no beacon line ever arrived), `beaconStatus:
"failed"` (a tracking-click navigation errored — core's own, or a
self-managing plugin's, reported via `recordBeaconOutcome`), or `beaconStatus:
"skipped"` (no beacon was ever applicable to this run — no `TrackingUrl` — or
the plugin manages its own tracking nav and hasn't reported an outcome for
it). All three are candidates for "why didn't this apply get credited," but
`"not_fired"` is the one worth alerting on unconditionally — `"skipped"` can
still be worth alerting on for a plugin you *expect* to self-report, since it
means that plugin hasn't called `recordBeaconOutcome` for this run yet (or
never will); for a plugin with no `extractJoinKeys` at all, `"skipped"`
remains the expected, explained default. `"not_fired"` always means a beacon
was applicable and its outcome was simply never recorded, regardless of which
kind of plugin handled the run.

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
      "siteId": "acme",
      "requestId": "req-1003",
      "joinKeys": { "jobReference": "4471_88215" },
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

## Recipe 3 — per-run lookup by a `joinKeys` field

Since `joinKeys` isn't filterable via the HTTP route's querystring, narrow by
`siteId` (and `from`/`to` if the field isn't unique on its own) and filter
the response client-side:

```bash
curl -s "http://localhost:3971/v1/submissions?siteId=acme&limit=1000" \
  -H "Authorization: Bearer $BARNACLE_API_KEY" \
  | jq '.submissions[] | select(.joinKeys.jobReference == "4471_88214")'
```

Output:

```json
{
  "siteId": "acme",
  "requestId": "req-1002",
  "joinKeys": { "jobReference": "4471_88214" },
  "status": "submitted",
  "errorMessage": null,
  "durationMs": 7650,
  "ts": "2026-07-20T15:10:03.000Z",
  "beaconStatus": "fired",
  "trackingUrl": "https://trk.example.com/click?empId=4471&jid=88214"
}
```

If you need to filter or join on a `joinKeys` field routinely — not just for
a one-off lookup — read the raw NDJSON with `jq` instead (below), or build
that filter into your own plugin-side tooling; it's out of scope for this
generic route.

---

## `jq` fallback: reading raw NDJSON directly

When you can't reach a running Barnacle instance, or you need
`inboundPayload`/`auditPayload` that `GET /v1/submissions` deliberately omits,
or you need to filter on a `joinKeys` field the route can't filter on, read
`.barnacle/submissions.ndjson` directly. `"submit"` lines written before
`kind` existed have no `kind` field at all (see
[telemetry-and-judging.md](./telemetry-and-judging.md#submission-envelope-sink));
the `select` below tolerates both. Mirrors the jq-recipe style already used
for `calls.ndjson` in [README.md](../README.md#tailing-call-samples-with-jq).

```bash
# Per-run lookup by a joinKeys field (only matches kinded or legacy-unkinded submit lines)
jq -c 'select(.kind == "submit" or (.kind == null and has("inboundPayload")))
       | select(.joinKeys.jobReference == "4471_88214")' .barnacle/submissions.ndjson
```

Output (against the same sample sink):

```
{"kind":"submit","siteId":"acme","requestId":"req-1002","joinKeys":{"jobReference":"4471_88214"},"inboundPayload":{"empId":"4471","jid":"88214"},"status":"submitted","auditPayload":{"confirmationId":"CNF-1002"},"errorMessage":null,"durationMs":7650,"ts":"2026-07-20T15:10:03.000Z"}
```

```bash
# Submitted-but-beacon-not-fired, computed by hand: submit requestIds with no matching beacon line
jq -s '
  [.[] | select(.kind == "submit" or (.kind == null and has("inboundPayload")))] as $submits |
  [.[] | select(.kind == "beacon") | .requestId] as $beaconIds |
  [$submits[] | select(.status == "submitted")
              | select(.requestId as $r | $beaconIds | index($r) | not)
              | {requestId, siteId, joinKeys, ts}]
' .barnacle/submissions.ndjson
```

Output:

```json
[
  {
    "requestId": "req-1003",
    "siteId": "acme",
    "joinKeys": { "jobReference": "4471_88215" },
    "ts": "2026-07-21T09:44:57.000Z"
  }
]
```

Same single row Recipe 2's HTTP call returned — the NDJSON fallback and the
read route agree, as expected since the route is built on the same folding
logic (`readReconciliationRows`, `src/lib/telemetry/submission-reader.ts`).

---

## File map

| Concern | File |
|---|---|
| Plugin-owned join-key extraction hook | `SitePlugin.extractJoinKeys` in `src/site-plugin.ts` |
| Plugin-callable beacon-outcome recorder (self-managed `fired`/`failed`) | `SitePluginContext.recordBeaconOutcome` in `src/site-plugin.ts`; wraps `src/lib/telemetry/beacon-outcome.ts` |
| Submit-record + beacon-event schemas | `src/lib/telemetry/reconciliation-record.ts` |
| Sink read path (folds beacon onto submit by `requestId`) | `src/lib/telemetry/submission-reader.ts` |
| Filter/sort/paginate layer | `src/lib/telemetry/submission-query.ts` |
| `GET /v1/submissions` route + querystring/response schemas | `src/api/routes/submissions.ts`, `src/api/schemas/submissions.ts` |
| Concept guide (why the sink is shaped this way) | [telemetry-and-judging.md](./telemetry-and-judging.md#submission-envelope-sink) |
