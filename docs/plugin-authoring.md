# Plugin Authoring Guide

How to write, register, and maintain a site plugin: the `SitePlugin`
contract, registration paths, reconciliation join keys, beacon-outcome
reporting, and the routes core exposes per site.

## The SitePlugin interface

A site plugin is a single TypeScript module satisfying `SitePlugin<TInput, TOutput>`
from `src/site-plugin.ts`. Built-in plugins register via `BUILTIN_SITE_PLUGINS` in
`src/plugins/discover.ts`; out-of-tree plugins load at startup via `BARNACLE_PLUGINS`.

```ts
interface SitePlugin<TPayload, TResult> {
  meta: SitePluginMeta;
  // Direct-HTTP hot path (millisecond latency, no LLM). Core tries this first;
  // falls back to execute() on HttpSchemaError / HttpBotChallengeError / HttpServerError.
  executeHttp?: (payload: TPayload, context: SitePluginContext) => Promise<SitePluginResult<TResult>>;
  // Browser fallback — Stagehand session (Browserbase by default, Steel via SCRAPER_PROVIDER), pooled by core.
  execute(payload: TPayload, session: BrowserSession, context: SitePluginContext): Promise<SitePluginResult<TResult>>;
  // Not called on CaptchaError/EmptyResultsError — p-retry skips onFailedAttempt for AbortError.
  onRetry?: (error: ScraperError, attempt: number) => void | Promise<void>;
}
```

## SitePluginMeta — required fields

| Field | Type | Purpose |
|---|---|---|
| `siteId` | `string` | Stable key for routing (`/v1/<siteId>/run`) and audit rows |
| `displayName?` | `string` | Label for logs and Swagger; `recon:generate` carries this through when `recon-flow.json` authors an optional `displayName` field (never derived from `siteId`) |
| `bodySchema` | `ZodTypeAny` | Request body schema — validated before `execute()` |
| `responseSchema` | `ZodTypeAny` | Success response schema — drives Swagger output |
| `routeOverride?` | `string` | Override the full route path (legacy compatibility only) |
| `defaultBaseUrl?` | `string` | Fallback when `config.scraper.siteBaseUrls[siteId]` is absent |
| `taskTimeoutMs?` / `maxAttempts?` | `number` | Override the pool's 60-min per-task ceiling / default 3-attempt retries (`maxAttempts: 1` makes `taskTimeoutMs` the real cap) |
| `apiVersion?` | `string` | Semver range (e.g. `"^1.0.0"`); disables the plugin on a major mismatch |
| `extraRoutes?` | `readonly SitePluginExtraRoute[]` | Extra authenticated routes (OTP trigger, resume, etc.) |
| `onShutdown?` | `() => Promise<void>` | Cleanup for fire-and-forget work, awaited during shutdown. Module plugins only |

## Plugin skeleton (hot path + browser fallback)

`pnpm run recon:generate` produces this structure automatically — REST sites use
`createRateLimitedJsonClient()`, GraphQL sites use `createGraphqlClient()`.

```ts
// src/sites/my-site/contract.ts
export const MySiteResponseSchema = z.object({ data: z.object({ items: z.array(z.object({ id: z.string() })) }) });
const MySitePayloadSchema = z.object({ query: z.string().min(1) });
type MySitePayload = z.infer<typeof MySitePayloadSchema>;
type MySiteResponse = z.infer<typeof MySiteResponseSchema>;

const httpClient = createRateLimitedJsonClient({ minTimeMs: 200, schema: MySiteResponseSchema, /* ... */ });

export const mySitePlugin: SitePlugin<MySitePayload, MySiteResponse> = {
  meta: {
    siteId: "my-site",
    bodySchema: MySitePayloadSchema,
    responseSchema: MySiteResponseSchema,
    defaultBaseUrl: "https://my-site.com",
  },
  // Hot path — no browser, no LLM tokens.
  async executeHttp(payload, context): Promise<SitePluginResult<MySiteResponse>> {
    const data = await httpClient(`${context.baseUrl}/api/search`, { method: "POST", body: JSON.stringify({ query: payload.query }) });
    return { data };
  },
  // Browser fallback, invoked automatically when the hot path fails.
  async execute(payload, session, context): Promise<SitePluginResult<MySiteResponse>> {
    return { data: await runMySiteBrowserFlow(session.stagehand, context.baseUrl, payload.query) };
  },
};
```

## The auditPayload hook

`SitePluginResult` accepts an optional `auditPayload` alongside `data` — when
present, core writes it (not `data`) to the submission-envelope telemetry
record, so you can strip PII or large blobs from the audit trail while
keeping the full response in the API reply:

```ts
return {
  data: responseData,
  auditPayload: { query: payload.query, resultCount: responseData.items.length },
};
```

## Reconciliation join keys (`extractJoinKeys`)

Core has no opinion on join-key shape — that's site-specific vocabulary (a click
ID, a job-reference composition, etc). Declare an optional `extractJoinKeys` hook,
called once per submission from the inbound payload, to make a plugin's
submission and beacon-fire telemetry joinable:

```ts
extractJoinKeys: (payload) =>
  payload.someVendorClickId ? { vendorClickId: payload.someVendorClickId } : null,
```

For keys only discoverable mid-run (a minted token, a value read
post-navigation), call `context.telemetry.addJoinKeys({ ... })` from inside
`execute()`/`executeHttp()` — it merges over `extractJoinKeys`'s output when
the call resolves, later calls winning on collision. A config-only
`*.plugin.json` manifest can only reach it via the `spec.httpModule` escape
hatch (its declarative browser flow has no imperative call site).

**Declaring `extractJoinKeys` opts the plugin out of core's automatic
`TrackingUrl` fire** (`dispatch()`'s `fireTrackingClick`), since core assumes
the plugin fires its own post-submit navigation instead (e.g. so click and
apply share one browser session for device-cookie attribution). Declare the
URL field via `MySitePayloadSchema.extend(JobTrackingSchema.shape)`
(`src/lib/job-tracking.ts`).

A self-managing plugin's beacon telemetry defaults to `beaconStatus: "skipped"`.
Report the real outcome (never throws, core binds `requestId`/`siteId` for
you) via `context.recordBeaconOutcome`, callable from `execute()`,
`executeHttp()`, or an extra-route handler:

```ts
await context.recordBeaconOutcome({ beaconStatus: fired ? "fired" : "failed", joinKeys, trackingUrl, durationMs });
```

A recorded `fired`/`failed` line outranks the automatic `skipped` line for the
same `requestId` (see [Telemetry & LLM judging](telemetry-and-judging.md)); a
config-only manifest reaches this only via `spec.httpModule`, and — since it
never gets `extractJoinKeys` — its line only outranks core's own
`TrackingUrl` fire when none was present.

## Static fixtures

If Phase 3b (auxiliary fixture detection) found static JSON endpoints (markets,
currencies, labels), `recon:generate` copies them to `src/sites/<id>/fixtures/`.
Load them at module init via `loadFixture()` — zero per-request overhead, and
throws at startup if the fixture is missing or stale:
`loadFixture("my-site", "markets.json", MarketsSchema)`. See
[docs/playbook.md — Phase 3b](playbook.md#3b--auxiliary-fixture-detection) for
detection details.

## Register the plugin

**Out-of-tree (recommended):** point `BARNACLE_PLUGINS` at the compiled plugin
module — no core edits required. Barnacle validates the export at startup and
registers `POST /v1/my-site/run`. See the env var table in README.md /
docs/configuration.md for `BARNACLE_PLUGINS_STRICT` / `BARNACLE_PLUGINS_DIR`.
Template: [`examples/plugins/hello-site/`](../examples/plugins/hello-site/).
`BARNACLE_PLUGINS=./plugins/my-site/dist/index.js pnpm start`

**Config-only (no TypeScript, no compile step):** a browser-flow plugin can be a
single JSON manifest with a Kubernetes-style `apiVersion` / `kind` / `metadata`
/ `spec` envelope, declaring request/response/extract shapes as JSON Schema and
the browser flow as data. Point `BARNACLE_PLUGINS` at the file (or drop
manifests into `BARNACLE_PLUGINS_CONFIG_DIR`); `spec.httpModule` can reference
a compiled `executeHttp` module for the direct-HTTP hot path. The JSON Schema
converter supports only `object`, `string`, `number`, `integer`, `boolean`,
`array` (with `items`), `enum`, `required` — flow steps interpolate
`{{ .request.FieldName }}`, failing loudly on an undeclared field. Template:
[`examples/plugins/acme-jobs.plugin.json`](../examples/plugins/acme-jobs.plugin.json).
`BARNACLE_PLUGINS=./plugins/acme-jobs.plugin.json pnpm start`

**In-tree (bundled built-ins only):** push to `BUILTIN_SITE_PLUGINS` in
`src/plugins/discover.ts` — core registers `POST /v1/my-site/run` at startup.
```ts
import { BUILTIN_SITE_PLUGINS } from "@/plugins/discover";
BUILTIN_SITE_PLUGINS.push(mySitePlugin as SitePlugin<unknown, unknown>);
```

## Wire up the nightly smoke test and maintenance loop

Add a step to `.github/workflows/smoke.yml`:

```yaml
- name: Run smoke test — my-site
  run: |
    pnpm run smoke -- --site my-site --payload '{"query":"test"}' \
      --host "$SMOKE_HOST" --fallback \
      --response-schema src/sites/my-site/contract.ts
  env:
    API_KEY: ${{ secrets.SMOKE_API_KEY }}
    SMOKE_HOST: ${{ secrets.SMOKE_HOST }}
```

`--response-schema` validates the full response body against a module's
default-exported Zod schema, so data-payload drift fails the pipeline
immediately. `--fallback` runs a second request via the Stagehand browser
path, catching cache staleness (a changed DOM pointing a cached selector at
the wrong element) before it hits production.

When the smoke test fails: re-run `pnpm run recon:browser` → diff
`<run-dir>/graphql/*<operationName>*.json` against `src/sites/<id>/contract.ts`
→ update query / headers / Zod schema → ship. See
[docs/playbook.md](playbook.md#phase-6--drift-detection) for the full loop and
change severity table.

## Endpoints

Each registered plugin exposes `POST /v1/<siteId>/run`. When the hot path
detects missing required applicant answers or a repeat-applicant OTP
challenge, `/run` returns HTTP 200 with `{ needsUserInfo: true, missingFields:
[{ field, question }], requiresOtp }` instead of a submission result.

Plugins declare extra routes via `meta.extraRoutes` (`:siteId` templated),
registered uniformly by core with no per-site knowledge. Two conventional
shapes — see `examples/plugins/acme-jobs.plugin.json` for a runnable example:

- `POST /v1/<siteId>/resume` — body = original payload + `collectedData`
  (and `otpCode` where applicable); re-runs the hot path with answers merged
  in; returns `{ verified }` like `/run`, or `2007 RESUME_INVALID_OTP`
- `POST /v1/<siteId>/trigger-otp` — body `{ offerId, email }`; returns
  `{ success: true }` or `2006 VERIFICATION_TRIGGER_FAILED`

Operational routes:
- `GET /healthz` / `GET /readyz` — liveness / readiness (credentials, queue depth)
- `GET /docs` — Swagger UI (when `ENABLE_DOCS=true`)
- `GET /v1/plugins` — authenticated plugin load report
- `GET /v1/submissions` — authenticated, queryable submit+beacon reconciliation
  rows (filter by `siteId`, `requestId`, `status`, `beaconStatus`, `from`/`to`).
  Each row carries `session` (`{ id, provider, ip, ipCapturedAt }`) and
  `beaconSessionIp`, neither filterable, same as the opaque `joinKeys` bag.
  See [Submission-envelope sink](telemetry-and-judging.md#submission-envelope-sink).
