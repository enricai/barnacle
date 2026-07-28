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
for the same `requestId` (see Recipe 4). Unlike `session`, `sessionIp` is
not returned by `GET /v1/submissions` today — read it from raw NDJSON
beacon lines.

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
  `siteId`/`requestId` first, then filter the response client-side; `session`
  itself, unlike a beacon line's `sessionIp`, IS present in the JSON body of
  every row (see Recipe 4). Schema: `src/api/schemas/submissions.ts`.
- **Raw NDJSON** (`.barnacle/submissions.ndjson`, path from
  `SUBMISSIONS_NDJSON_PATH`) via `jq` — the fallback when you need a shape the
  route doesn't expose yet (e.g. `inboundPayload`/`auditPayload`, or a beacon
  line's `sessionIp` — the route only re-exposes `beaconStatus`/`trackingUrl`
  from the beacon side, not `sessionIp`), or when you don't have network
  access to a running Barnacle instance, or you need to filter/join on a
  specific `joinKeys` field the route can't filter on.

All recipes below were run against a locally generated sample sink (same
shape as production, 5 submits across two `siteId` cohorts + 4 beacon lines)
with a real Barnacle instance on `localhost:3971` and `DEV_BYPASS_AUTH=true`,
and the output is shown verbatim.

Sample rows used (`kind: "submit"` / `kind: "beacon"` lines, abbreviated —
`joinKeys` here happens to carry a `vivclid`/`jobReference` pair, but the
route treats it as an opaque bag regardless of what's inside). `session.ip`
is the submit session's own outbound IP; `beacon sessionIp` is the
*different*, tracking-click session's outbound IP, present only on rows with
a beacon line:

| `requestId` | `siteId` | `joinKeys` | `status` | `session.ip` | beacon | beacon `sessionIp` |
|---|---|---|---|---|---|---|
| `req-1001` | `acme` | `{vivclid: "vc-9f3a21", jobReference: "4471_88213"}` | `submitted` | `203.0.113.7` | `fired` | `198.51.100.23` |
| `req-1002` | `acme` | `{jobReference: "4471_88214"}` | `submitted` | `203.0.113.9` | `fired` | `198.51.100.24` |
| `req-1003` | `acme` | `{jobReference: "4471_88215"}` | `submitted` | `203.0.113.11` | _(no beacon line)_ | — |
| `req-1004` | `acme` | `{vivclid: "vc-1120bb", jobReference: "4471_88216"}` | `error` | `203.0.113.13` | _(no beacon line)_ | — |
| `req-1005` | `other-site` | `{jobReference: "5502_11029"}` | `submitted` | `203.0.113.15` | `fired` | `198.51.100.26` |
| `req-1006` | `acme` | `{jobReference: "4471_88217"}` | `submitted` | `203.0.113.17` | `failed` | `198.51.100.27` |

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
"failed"` (the tracking-click navigation errored — either core's own fire or
a plugin-recorded one), or `beaconStatus: "skipped"` (`dispatch()`'s own
synchronous default: no `TrackingUrl` was ever applicable, or the plugin
manages its own tracking nav outside `dispatch()`). A self-managing plugin
can call `context.recordBeaconOutcome()` to report a real `fired`/`failed`
outcome for its own navigation; when it does, that line always outranks the
automatic `skipped` line for the same `requestId` in the fold, regardless of
write order (`foldReconciliationRecords`,
[telemetry-and-judging.md](./telemetry-and-judging.md#submission-envelope-sink)) —
so a row you read as `"skipped"` really never got a real outcome recorded,
not just "not read yet."

All three non-`"fired"` outcomes are candidates for "why didn't this apply
get credited," but they don't carry equal alerting weight. `"not_fired"` is
always worth alerting on — a beacon was applicable and no outcome at all was
recorded. `"skipped"` is murkier than it used to be: for a plugin with no
`TrackingUrl` it's still an expected, terminal outcome, but for a
self-managing plugin it now also covers "this plugin never adopted
`recordBeaconOutcome`" and "this plugin adopted it but didn't call it for
this run" — both look identical to a permanently-uninterested plugin from
this row alone. Whether a given `siteId`'s self-managing plugin is expected
to call `recordBeaconOutcome` is site-specific knowledge this runbook
doesn't have — check that plugin's own docs before deciding whether its
`"skipped"` rows are alertable.

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
      "session": {
        "id": "sess_71c9",
        "provider": "browserbase",
        "ip": "203.0.113.11",
        "ipCapturedAt": "2026-07-21T09:44:57.000Z"
      },
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
  "session": {
    "id": "sess_71b4",
    "provider": "browserbase",
    "ip": "203.0.113.9",
    "ipCapturedAt": "2026-07-20T15:10:03.000Z"
  },
  "beaconStatus": "fired",
  "trackingUrl": "https://trk.example.com/click?empId=4471&jid=88214"
}
```

If you need to filter or join on a `joinKeys` field routinely — not just for
a one-off lookup — read the raw NDJSON with `jq` instead (below), or build
that filter into your own plugin-side tooling; it's out of scope for this
generic route.

---

## Recipe 4 — matching a run's session IP against a third-party report's IP column

Two different Browserbase sessions can carry an IP for the same `requestId`:
the submit line's `session.ip` (the session that filled out and submitted
the application) and the matching beacon line's `sessionIp` (the session the
engine-owned tracking-click opened to fire the plugin's `TrackingUrl`). An
attribution vendor's own report reflects the request that hit *their*
tracking pixel, so it's the beacon line's `sessionIp` — not `session.ip` —
that lines up against a third-party report's IP column.

Both are `null` under the same conditions as the field-table entries above:
session-IP capture disabled (`SCRAPER_CAPTURE_SESSION_IP=false`), a
non-Browserbase provider, or the IP-echo navigation timing out
(`SCRAPER_SESSION_IP_TIMEOUT_MS`, default `10000`). Neither failure affects
`status`/`beaconStatus` — a `null` IP just means this corroboration signal
isn't available for that run, not that the run itself failed.

`sessionIp` is not exposed by `GET /v1/submissions` (see above), so pull it
from raw NDJSON, keyed by the same `joinKeys` field your external report
uses to identify a run:

```bash
# Beacon session IP for a run identified by the report's jobReference column
jq -c '
  select(.kind == "beacon")
  | select(.joinKeys.jobReference == "4471_88214")
  | {requestId, siteId, joinKeys, sessionIp, beaconStatus, ts}
' .barnacle/submissions.ndjson
```

Output:

```
{"requestId":"req-1002","siteId":"acme","joinKeys":{"jobReference":"4471_88214"},"sessionIp":"198.51.100.24","beaconStatus":"fired","ts":"2026-07-20T15:10:20.000Z"}
```

Compare `sessionIp` above against the corresponding row of the external
report. For a batch of runs rather than a one-off lookup, drop the
`joinKeys.jobReference` filter and fold over every beacon line:

```bash
jq -sc '
  [.[] | select(.kind == "beacon")]
  | map({requestId, siteId, joinKeys, sessionIp, beaconStatus})
' .barnacle/submissions.ndjson
```

The submit-side `session` block (which session actually performed the
apply, as opposed to which fired the beacon) doesn't need the NDJSON
fallback — it flows through `GET /v1/submissions` automatically, so a
batch lookup can go through the route instead:

```bash
curl -s "http://localhost:3971/v1/submissions?siteId=acme&limit=1000" \
  -H "Authorization: Bearer $BARNACLE_API_KEY" \
  | jq '.submissions[] | select(.joinKeys.jobReference == "4471_88214") | {requestId, session}'
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
  }
}
```

Note `session.ip` (`203.0.113.9`) and the beacon's `sessionIp`
(`198.51.100.24`) differ for the same `requestId` — expected, since they're
two different sessions; don't treat a mismatch between them as a
reconciliation failure. Only the beacon's `sessionIp` is the field to
compare against the external report.

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
{"kind":"submit","siteId":"acme","requestId":"req-1002","joinKeys":{"jobReference":"4471_88214"},"inboundPayload":{"empId":"4471","jid":"88214"},"status":"submitted","auditPayload":{"confirmationId":"CNF-1002"},"errorMessage":null,"durationMs":7650,"ts":"2026-07-20T15:10:03.000Z","session":{"id":"sess_71b4","provider":"browserbase","ip":"203.0.113.9","ipCapturedAt":"2026-07-20T15:10:03.000Z"}}
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
| Mid-run join-key attach point (fields `extractJoinKeys` can't see — discovered after navigation, minted mid-flow, etc.) | `SitePluginContext.telemetry` (`RunTelemetryCollector.addJoinKeys()`) in `src/site-plugin.ts`, built by `src/lib/telemetry/run-telemetry.ts` |
| Plugin-callable beacon-outcome recorder (bound to the run's `requestId`/`siteId`) | `SitePluginContext.recordBeaconOutcome` in `src/site-plugin.ts`, built by `createBeaconOutcomeRecorder` in `src/lib/telemetry/beacon-capture.ts` |
| Browser-session outbound-IP resolver (IP-echo navigation against a configurable endpoint) | `src/scraper/session-ip.ts` |
| Memoized `getOutboundIp()` accessor on Browserbase sessions + `SCRAPER_CAPTURE_SESSION_IP`/`SCRAPER_SESSION_IP_ECHO_URL`/`SCRAPER_SESSION_IP_TIMEOUT_MS` config | `src/scraper/session-browserbase.ts`, `src/config.ts` |
| Submit-record + beacon-event schemas (incl. `session` and `sessionIp`) | `src/lib/telemetry/reconciliation-record.ts` |
| Sink read path (folds beacon onto submit by `requestId`, real outcome outranks `skipped`) | `src/lib/telemetry/submission-reader.ts` |
| Filter/sort/paginate layer | `src/lib/telemetry/submission-query.ts` |
| `GET /v1/submissions` route + querystring/response schemas | `src/api/routes/submissions.ts`, `src/api/schemas/submissions.ts` |
| Concept guide (why the sink is shaped this way) | [telemetry-and-judging.md](./telemetry-and-judging.md#submission-envelope-sink) |
