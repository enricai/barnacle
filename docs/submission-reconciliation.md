# Submission Reconciliation Runbook

> How to join a Barnacle run to a row in your own attribution provider's
> report. This is the operator runbook — the *what fields, what queries*
> companion to the concept guide in
> [telemetry-and-judging.md](./telemetry-and-judging.md#submission-envelope-sink),
> which explains *why* the sink is shaped the way it is.

**Audience:** whoever reconciles attribution-provider payment against
Barnacle's own submit + beacon-fire records, without re-parsing raw NDJSON
by hand every time. This runbook only covers fields core knows about — for
a worked example with real join-key recipes, see that plugin's own docs.

## Fields every reconciliation row carries

| Field | Meaning |
|---|---|
| `siteId` | The plugin that handled the request — the cohort dimension for roll-ups. |
| `requestId` | Joins a submit row to its beacon row; also for cross-referencing app logs. |
| `joinKeys` | Opaque `Record<string, unknown> \| null` — see below. |
| `status` | `"submitted"` or `"error"` — whether the submit attempt succeeded, distinct from beacon fire. |
| `beaconStatus` | `"fired"`, `"failed"`, `"skipped"`, or `"not_fired"` — see below. |
| `session` | Nullable object `{ id, provider, ip, ipCapturedAt }` — see below. |
| `ts` | ISO-8601. Use with `from`/`to` to bound a report's window. |

**`joinKeys`** merges two sources: whatever the plugin's `extractJoinKeys`
hook resolved from the inbound payload (an attribution vendor's click ID, a
job reference, etc.), plus any fields the plugin attached mid-run via
`context.telemetry.addJoinKeys()` — a token minted mid-flow, a value read
off the page after navigation, or anything `extractJoinKeys` can't see
because it only receives the inbound payload. A run-attached field wins on
collision. `null` only when the plugin has neither hook.

**`beaconStatus`** values:

- `"fired"` / `"failed"` — a real outcome, recorded either by core firing
  the plugin's `TrackingUrl` itself, or by a self-managing plugin (one that
  declares `extractJoinKeys`) calling `context.recordBeaconOutcome()` from
  its own tracking nav.
- `"skipped"` — `dispatch()`'s synchronous default for a self-managing
  plugin; terminal only until that plugin calls `recordBeaconOutcome`. A
  non-null `trackingUrl` confirms core saw one, but no longer proves the
  plugin fired it. A later real `fired`/`failed` for the same `requestId`
  always outranks `skipped` when folded (Recipe 2).
- `"not_fired"` — a submit row with no matching beacon line.

**`session`** is nullable: identity + outbound IP of the browser session
that performed the *submit*. `ip`/`ipCapturedAt` are `null` when
`SCRAPER_CAPTURE_SESSION_IP=false` (default `true`), the provider exposes no
outbound-IP accessor (Steel doesn't; Browserbase does), or the IP-echo nav
timed out (`SCRAPER_SESSION_IP_TIMEOUT_MS`). The object is `null` only when
no session was created.

Beacon lines carry their own `sessionIp` instead of `session` — the
tracking-click opens its own Browserbase session, so it's not the same IP
as the matching submit row's `session.ip` (Recipe 4). `GET /v1/submissions`
renames it `beaconSessionIp` to avoid colliding with `session.ip`.

## Reading the sink: HTTP route vs. raw NDJSON

- **`GET /v1/submissions`** (authenticated) — the queryable read path. Prefer
  this; it left-joins beacon rows onto submit rows and paginates for you.
  Querystring params: `siteId`, `requestId`, `status`, `beaconStatus`
  (`fired`/`failed`/`skipped`/`not_fired`), `from`/`to` (ISO-8601, inclusive),
  `limit` (max `1000`), `offset`. `joinKeys`/`session` aren't filterable here
  — narrow with `siteId`/`requestId`, then filter client-side; both are in
  the JSON body of every row (Recipe 4). Schema: `src/api/schemas/submissions.ts`.
- **Raw NDJSON** (`.barnacle/submissions.ndjson`, path from
  `SUBMISSIONS_NDJSON_PATH`) via `jq` — the fallback for shapes the route
  doesn't expose (`inboundPayload`/`auditPayload`), no network access to a
  running instance, or filtering on a specific `joinKeys` field.

Recipes below ran against a local sample sink (5 submits across two
`siteId` cohorts + 4 beacon lines) on `localhost:3971` with
`DEV_BYPASS_AUTH=true`; replace host/port/query values with your own.

| `requestId` | `siteId` | `joinKeys` | `status` | `session.ip` | beacon | beacon `sessionIp` |
|---|---|---|---|---|---|---|
| `req-1001` | `acme` | `{clickId: "vc-9f3a21", refId: "4471_88213"}` | `submitted` | `203.0.113.7` | `fired` | `198.51.100.23` |
| `req-1002` | `acme` | `{refId: "4471_88214"}` | `submitted` | `203.0.113.9` | `fired` | `198.51.100.24` |
| `req-1003` | `acme` | `{refId: "4471_88215"}` | `submitted` | `203.0.113.11` | _(no beacon line)_ | — |
| `req-1004` | `acme` | `{clickId: "vc-1120bb", refId: "4471_88216"}` | `error` | `203.0.113.13` | _(no beacon line)_ | — |
| `req-1005` | `other-site` | `{refId: "5502_11029"}` | `submitted` | `203.0.113.15` | `fired` | `198.51.100.26` |
| `req-1006` | `acme` | `{refId: "4471_88217"}` | `submitted` | `203.0.113.17` | `failed` | `198.51.100.27` |

## Recipe 1 — cohort roll-up by `siteId`

```bash
curl -s "http://localhost:3971/v1/submissions?siteId=acme&limit=1000" \
  -H "Authorization: Bearer $BARNACLE_API_KEY" | jq '.submissions | length'
```

Output: `5`. Counts every row regardless of `status`, so errored submits are
included — filter client-side or narrow with `from`/`to`.

## Recipe 2 — submitted but the beacon did not fire

Filters on `beaconStatus: "not_fired"` (see above for how it differs from
`"skipped"`/`"failed"`) alongside `status: "submitted"`, excluding failed
applies that were never beacon-eligible.

```bash
curl -s "http://localhost:3971/v1/submissions?status=submitted&beaconStatus=not_fired" \
  -H "Authorization: Bearer $BARNACLE_API_KEY" | jq .
```

Output (trimmed to the matching row):

```json
{"submissions": [{"siteId": "acme", "requestId": "req-1003", "joinKeys": {"refId": "4471_88215"}, "status": "submitted", "beaconStatus": "not_fired", "trackingUrl": null, "beaconSessionIp": null}], "total": 1}
```

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
{"siteId": "acme", "requestId": "req-1002", "joinKeys": {"refId": "4471_88214"}, "status": "submitted", "beaconStatus": "fired", "trackingUrl": "https://trk.example.com/click?empId=4471&jid=88214", "beaconSessionIp": "198.51.100.24"}
```

For routine filtering/joining on a `joinKeys` field, read the raw NDJSON
with `jq` instead (see below).

## Recipe 4 — matching a run's session IP against a third-party report's IP column

An attribution vendor's report reflects the request that hit *their*
tracking pixel — so match against the beacon line's `sessionIp`, not the
submit line's `session.ip`. To read it straight from the sink, keyed by the
`joinKeys` field your external report uses to identify a run:

```bash
jq -c 'select(.kind == "beacon") | select(.joinKeys.refId == "4471_88214")
       | {requestId, siteId, joinKeys, sessionIp, beaconStatus, ts}' \
  .barnacle/submissions.ndjson
```

```
{"requestId":"req-1002","siteId":"acme","joinKeys":{"refId":"4471_88214"},"sessionIp":"198.51.100.24","beaconStatus":"fired","ts":"2026-07-20T15:10:20.000Z"}
```

For a batch of runs, drop the `joinKeys.refId` filter and fold over every
beacon line, or skip NDJSON entirely — `GET /v1/submissions` exposes the
same field as `beaconSessionIp` on each row:

```bash
curl -s "http://localhost:3971/v1/submissions?siteId=acme&limit=1000" \
  -H "Authorization: Bearer $BARNACLE_API_KEY" \
  | jq '.submissions[] | select(.joinKeys.refId == "4471_88214") | {requestId, session, beaconSessionIp}'
```

Output:

```json
{"requestId": "req-1002", "session": {"id": "sess_71b4", "provider": "browserbase", "ip": "203.0.113.9"}, "beaconSessionIp": "198.51.100.24"}
```

`session.ip` (`203.0.113.9`) and `beaconSessionIp` (`198.51.100.24`) differ
for the same `requestId` by design — don't treat that mismatch as a
reconciliation failure. Only `beaconSessionIp` compares against the
external report.

## `jq` fallback: reading raw NDJSON directly

Use `.barnacle/submissions.ndjson` directly when you can't reach a running
instance, need `inboundPayload`/`auditPayload` (omitted from the route), or
need to filter on a `joinKeys` field. Every line carries `kind`.

```bash
# Per-run lookup by a joinKeys field
jq -c 'select(.kind == "submit") | select(.joinKeys.refId == "4471_88214")' \
  .barnacle/submissions.ndjson

# Submitted-but-beacon-not-fired, computed by hand
jq -s '
  [.[] | select(.kind == "submit")] as $submits |
  [.[] | select(.kind == "beacon") | .requestId] as $beaconIds |
  [$submits[] | select(.status == "submitted")
              | select(.requestId as $r | $beaconIds | index($r) | not)
              | {requestId, siteId, joinKeys, ts}]
' .barnacle/submissions.ndjson
```

Output for the second command — same row Recipe 2's HTTP call returned; NDJSON and the route agree (`readReconciliationRows`, `src/lib/telemetry/submission-reader.ts`):

```json
[{"requestId": "req-1003", "siteId": "acme", "joinKeys": {"refId": "4471_88215"}, "ts": "2026-07-21T09:44:57.000Z"}]
```

For the reconciliation-sink source files (join-key hooks, beacon-outcome recorder, session-IP resolver, schemas, route), see [architecture.md § File map](./architecture.md#file-map).
