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
| `joinKeys` | Opaque `Record<string, unknown> \| null` — merges whatever the plugin's own `extractJoinKeys` hook resolved from the inbound payload (an attribution vendor's click ID, a job reference, or whatever that plugin's provider needs) with any fields the plugin attached mid-run via `context.telemetry.addJoinKeys()` from inside `execute()`/`executeHttp()` — a token minted mid-flow, a value read off the page after navigation, or anything else `extractJoinKeys` can't see because it only ever receives the inbound payload. A run-attached field wins over a payload-derived one on key collision. Core does not know or validate its shape; `null` only when the plugin has neither `extractJoinKeys` nor a mid-run `addJoinKeys()` call for a given run. |
| `status` | `"submitted"` or `"error"` — whether Barnacle's own submit attempt succeeded, distinct from beacon fire. |
| `beaconStatus` | `"fired"`, `"failed"`, `"skipped"`, or `"not_fired"` — a dimension separate from `status`. `"fired"`/`"failed"` mean a real outcome was recorded — either core fired the plugin's `TrackingUrl` itself, or a self-managing plugin (one that declares `extractJoinKeys`) called `context.recordBeaconOutcome()` from its own tracking nav; this row alone doesn't tell you which. `"skipped"` is `dispatch()`'s own synchronous default for a self-managing plugin, and stays the terminal outcome for a run where that plugin never calls `recordBeaconOutcome`: a real (non-null) `trackingUrl` on a `skipped` row confirms core saw a `TrackingUrl`, but is no longer proof the plugin fired it — `null` still means no usable `TrackingUrl` was ever present. If the same plugin later records a real `fired`/`failed` outcome for the same `requestId`, that line always outranks the automatic `skipped` line when folded (see Recipe 2) — you'll see the real outcome instead of `skipped`. `"not_fired"` means a submit row exists with no matching beacon line at all (a beacon was applicable but no outcome — not even `skipped` — was ever recorded). |
| `session` | Nullable object `{ id, provider, ip, ipCapturedAt }` — identity and outbound IP of the browser session that performed the *submit*, captured once per run on both the success and error path. `ip`/`ipCapturedAt` are `null` when session-IP capture is disabled (`SCRAPER_CAPTURE_SESSION_IP=false`; default `true`), the session's provider exposes no outbound-IP accessor (Steel sessions don't — only Browserbase-backed ones do), or the IP-echo navigation failed or timed out (`SCRAPER_SESSION_IP_TIMEOUT_MS`). The whole `session` object is `null` only when no session was ever created for the run. |
| `ts` | ISO-8601. Use with `from`/`to` to bound a report's date window. |

`joinKeys` and `siteId` appear on both `"submit"` and `"beacon"` sink lines
and on every row `GET /v1/submissions` returns. `session` does not: it's a
submit-only field for the session that performed the apply. Beacon lines
carry their own, separate `sessionIp` field instead — the tracking-click
that fires a beacon opens its own Browserbase session, so a beacon line's
`sessionIp` is not the same IP as `session.ip` on the matching submit line
for the same `requestId` (see Recipe 4). `GET /v1/submissions` returns it
too, renamed to `beaconSessionIp` so it doesn't collide with the submit
row's own `session.ip`.

---

## Reading the sink: HTTP route vs. raw NDJSON

Two ways to run these recipes:

- **`GET /v1/submissions`** (authenticated) — the queryable read path. Prefer
  this; it left-joins beacon rows onto submit rows and paginates for you.
  Querystring params: `siteId`, `requestId`, `status`, `beaconStatus`
  (`fired` / `failed` / `skipped` / `not_fired`), `from`/`to` (ISO-8601,
  inclusive), `limit` (max `1000`), `offset`. `joinKeys` and `session` are not
  filterable at this layer (core doesn't know `joinKeys`'s shape, and there's
  no querystring param for `session.ip` either) — narrow with
  `siteId`/`requestId` first, then filter the response client-side; both
  `session` and the beacon line's `sessionIp` (renamed `beaconSessionIp`
  on the row) ARE present in the JSON body of every row (see Recipe 4).
  Schema: `src/api/schemas/submissions.ts`.
- **Raw NDJSON** (`.barnacle/submissions.ndjson`, path from
  `SUBMISSIONS_NDJSON_PATH`) via `jq` — the fallback when you need a shape the
  route doesn't expose (e.g. `inboundPayload`/`auditPayload`), or when you
  don't have network access to a running Barnacle instance, or you need to
  filter/join on a specific `joinKeys` field the route can't filter on.

All recipes below were run against a locally generated sample sink (same
shape as production, 5 submits across two `siteId` cohorts + 4 beacon lines)
with a real Barnacle instance on `localhost:3971` and `DEV_BYPASS_AUTH=true`,
and the output is shown verbatim.

Sample rows used (`kind: "submit"` / `kind: "beacon"` lines, abbreviated —
`joinKeys` here happens to carry a `clickId`/`refId` pair, but the
route treats it as an opaque bag regardless of what's inside). `session.ip`
is the submit session's own outbound IP; `beacon sessionIp` is the
*different*, tracking-click session's outbound IP, present only on rows with
a beacon line:

| `requestId` | `siteId` | `joinKeys` | `status` | `session.ip` | beacon | beacon `sessionIp` |
|---|---|---|---|---|---|---|
| `req-1001` | `acme` | `{clickId: "vc-9f3a21", refId: "4471_88213"}` | `submitted` | `203.0.113.7` | `fired` | `198.51.100.23` |
| `req-1002` | `acme` | `{refId: "4471_88214"}` | `submitted` | `203.0.113.9` | `fired` | `198.51.100.24` |
| `req-1003` | `acme` | `{refId: "4471_88215"}` | `submitted` | `203.0.113.11` | _(no beacon line)_ | — |
| `req-1004` | `acme` | `{clickId: "vc-1120bb", refId: "4471_88216"}` | `error` | `203.0.113.13` | _(no beacon line)_ | — |
| `req-1005` | `other-site` | `{refId: "5502_11029"}` | `submitted` | `203.0.113.15` | `fired` | `198.51.100.26` |
| `req-1006` | `acme` | `{refId: "4471_88217"}` | `submitted` | `203.0.113.17` | `failed` | `198.51.100.27` |

Replace the sample host/port and query values with your own before running
these against a real environment.

---

## Recipe 1 — cohort roll-up by `siteId`

```bash
curl -s "http://localhost:3971/v1/submissions?siteId=acme&limit=1000" \
  -H "Authorization: Bearer $BARNACLE_API_KEY" | jq '.submissions | length'
```

Output: `5`. Counts every row for the cohort regardless of `status`, so
errored submits are included — filter client-side by `status`/`beaconStatus`,
or narrow with `from`/`to`.

---

## Recipe 2 — submitted but the beacon did not fire

Filters on `beaconStatus: "not_fired"` (see the field table above for how it
differs from `"skipped"`/`"failed"`) alongside `status: "submitted"`, so a
failed apply that was never beacon-eligible is correctly excluded.

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
      "joinKeys": { "refId": "4471_88215" },
      "status": "submitted",
      "errorMessage": null,
      "durationMs": 9021,
      "ts": "2026-07-21T09:44:57.000Z",
      "session": {
        "id": "sess_71c9",
        "provider": "browserbase",
        "ip": "203.0.113.11",
        "ipCapturedAt": "2026-07-21T09:44:57.000Z"
      },
      "beaconStatus": "not_fired",
      "trackingUrl": null,
      "beaconSessionIp": null
    }
  ],
  "total": 1
}
```

---

## Recipe 3 — per-run lookup by a `joinKeys` field

`joinKeys` isn't filterable via the querystring, so narrow by `siteId` and
filter client-side:

```bash
curl -s "http://localhost:3971/v1/submissions?siteId=acme&limit=1000" \
  -H "Authorization: Bearer $BARNACLE_API_KEY" \
  | jq '.submissions[] | select(.joinKeys.refId == "4471_88214")'
```

Output:

```json
{
  "siteId": "acme",
  "requestId": "req-1002",
  "joinKeys": { "refId": "4471_88214" },
  "status": "submitted",
  "errorMessage": null,
  "durationMs": 7650,
  "ts": "2026-07-20T15:10:03.000Z",
  "session": {
    "id": "sess_71b4",
    "provider": "browserbase",
    "ip": "203.0.113.9",
    "ipCapturedAt": "2026-07-20T15:10:03.000Z"
  },
  "beaconStatus": "fired",
  "trackingUrl": "https://trk.example.com/click?empId=4471&jid=88214",
  "beaconSessionIp": "198.51.100.24"
}
```

For routine filtering/joining on a `joinKeys` field, read the raw NDJSON
with `jq` instead (below).

---

## Recipe 4 — matching a run's session IP against a third-party report's IP column

An attribution vendor's report reflects the request that hit *their*
tracking pixel — so match against the beacon line's `sessionIp`, not the
submit line's `session.ip` (see the field table above for when either is
`null`). To read it straight from the sink, keyed by the `joinKeys` field
your external report uses to identify a run:

```bash
# Beacon session IP for a run identified by the report's refId column
jq -c '
  select(.kind == "beacon")
  | select(.joinKeys.refId == "4471_88214")
  | {requestId, siteId, joinKeys, sessionIp, beaconStatus, ts}
' .barnacle/submissions.ndjson
```

Output:

```
{"requestId":"req-1002","siteId":"acme","joinKeys":{"refId":"4471_88214"},"sessionIp":"198.51.100.24","beaconStatus":"fired","ts":"2026-07-20T15:10:20.000Z"}
```

For a batch of runs, drop the `joinKeys.refId` filter and fold over every
beacon line:

```bash
jq -sc '
  [.[] | select(.kind == "beacon")]
  | map({requestId, siteId, joinKeys, sessionIp, beaconStatus})
' .barnacle/submissions.ndjson
```

Or skip NDJSON entirely — `GET /v1/submissions` exposes the same field as
`beaconSessionIp` on each row, so a batch lookup can go through the route in
one call:

```bash
curl -s "http://localhost:3971/v1/submissions?siteId=acme&limit=1000" \
  -H "Authorization: Bearer $BARNACLE_API_KEY" \
  | jq '.submissions[] | select(.joinKeys.refId == "4471_88214") | {requestId, session, beaconSessionIp}'
```

Output:

```json
{
  "requestId": "req-1002",
  "session": {
    "id": "sess_71b4",
    "provider": "browserbase",
    "ip": "203.0.113.9",
    "ipCapturedAt": "2026-07-20T15:10:03.000Z"
  },
  "beaconSessionIp": "198.51.100.24"
}
```

`session.ip` (`203.0.113.9`) and `beaconSessionIp` (`198.51.100.24`) differ
for the same `requestId` by design — don't treat that mismatch as a
reconciliation failure. Only `beaconSessionIp` compares against the
external report.

---

## `jq` fallback: reading raw NDJSON directly

Use `.barnacle/submissions.ndjson` directly when you can't reach a running
instance, need `inboundPayload`/`auditPayload` (omitted from the route), or
need to filter on a `joinKeys` field. Every line carries `kind`.

```bash
# Per-run lookup by a joinKeys field
jq -c 'select(.kind == "submit")
       | select(.joinKeys.refId == "4471_88214")' .barnacle/submissions.ndjson
```

Output (against the same sample sink):

```
{"kind":"submit","siteId":"acme","requestId":"req-1002","joinKeys":{"refId":"4471_88214"},"inboundPayload":{"empId":"4471","jid":"88214"},"status":"submitted","auditPayload":{"confirmationId":"CNF-1002"},"errorMessage":null,"durationMs":7650,"ts":"2026-07-20T15:10:03.000Z","session":{"id":"sess_71b4","provider":"browserbase","ip":"203.0.113.9","ipCapturedAt":"2026-07-20T15:10:03.000Z"}}
```

```bash
# Submitted-but-beacon-not-fired, computed by hand: submit requestIds with no matching beacon line
jq -s '
  [.[] | select(.kind == "submit")] as $submits |
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
    "joinKeys": { "refId": "4471_88215" },
    "ts": "2026-07-21T09:44:57.000Z"
  }
]
```

Same single row Recipe 2's HTTP call returned — the NDJSON fallback and the
read route agree, as expected since the route is built on the same folding
logic (`readReconciliationRows`, `src/lib/telemetry/submission-reader.ts`).

---

For the reconciliation-sink source files (join-key hooks, beacon-outcome
recorder, session-IP resolver, schemas, route), see
[architecture.md § File map](./architecture.md#file-map).
