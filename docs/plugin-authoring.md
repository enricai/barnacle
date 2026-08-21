# Plugin Authoring Guide

> Everything needed to write, register, and maintain a site plugin — the
> `SitePlugin` contract, the three registration paths, reconciliation join
> keys, beacon-outcome reporting, and the routes core exposes for each site.

---

## The SitePlugin interface

A site plugin is a single TypeScript module that satisfies `SitePlugin<TInput, TOutput>`
from `src/site-plugin.ts`. Core registers built-in plugins via `BUILTIN_SITE_PLUGINS` in
`src/plugins/discover.ts`; out-of-tree plugins are loaded at startup via `BARNACLE_PLUGINS`.

```ts
interface SitePlugin<TPayload, TResult> {
  meta: SitePluginMeta;
  // Optional direct-HTTP hot path — no browser, no LLM tokens, millisecond latency.
  // Core tries this first; falls back to execute() on HttpSchemaError / HttpBotChallengeError / HttpServerError.
  executeHttp?: (
    payload: TPayload,
    context: SitePluginContext
  ) => Promise<SitePluginResult<TResult>>;
  // Browser fallback — Stagehand + Steel session, acquired from the pool by core.
  execute(
    payload: TPayload,
    session: BrowserSession,
    context: SitePluginContext
  ): Promise<SitePluginResult<TResult>>;
  // Async work is supported. Note: NOT called on CaptchaError or EmptyResultsError —
  // p-retry skips onFailedAttempt for AbortError, so those abort paths bypass this hook.
  onRetry?: (error: ScraperError, attempt: number) => void | Promise<void>;
}
```

## SitePluginMeta — required fields

| Field | Type | Purpose |
|---|---|---|
| `siteId` | `string` | Stable key used for routing (`/v1/<siteId>/run`) and audit rows |
| `displayName?` | `string` | Human-readable label for logs and Swagger docs. `recon:generate` does not derive this — plugin authors set it explicitly |
| `bodySchema` | `ZodTypeAny` | Request body schema — core validates before calling `execute()` |
| `responseSchema` | `ZodTypeAny` | Success response schema — drives Swagger output shape |
| `routeOverride?` | `string` | Override the full route path (legacy compatibility only) |
| `defaultBaseUrl?` | `string` | Fallback base URL when `config.scraper.siteBaseUrls[siteId]` is absent |
| `taskTimeoutMs?` | `number` | Override the pool's 60-minute per-task hang ceiling for this plugin only — set when the site's normal latency is well below the default and a faster failure is preferable |
| `maxAttempts?` | `number` | Override the retry policy's default of 3 attempts (including the first try). Without this, the per-run ceiling is `3 × taskTimeoutMs`; set to `1` so `taskTimeoutMs` is the real per-run cap |
| `apiVersion?` | `string` | Semver range targeting a plugin API version (e.g. `"^1.0.0"`); core disables the plugin on a major-version mismatch. Absent means "accept any version." |
| `extraRoutes?` | `readonly SitePluginExtraRoute[]` | Extra non-run routes (OTP trigger, resume, etc.) that core registers as authenticated Fastify routes at startup. See `SitePluginExtraRoute` in `src/site-plugin.ts`. |
| `onShutdown?` | `() => Promise<void>` | Optional cleanup for background work the plugin launched fire-and-forget, awaited during graceful shutdown so in-flight work is not abandoned and sessions are not leaked. Parallels the engine's own drain functions. Bounded by a per-plugin timeout, so a hanging drain cannot stall shutdown. Module plugins only — config-only `*.plugin.json` manifests are pure JSON and cannot declare a function. |

## Full plugin skeleton (hot path + browser fallback)

`pnpm run recon:generate` produces this structure automatically. Use `createRateLimitedJsonClient()` for REST endpoints that send Chromium client-hint headers (the common case) and `createGraphqlClient()` for GraphQL endpoints — `recon:generate` selects the right one based on what it captured. The skeleton below illustrates the REST hot-path pattern; for GraphQL sites, `recon-generate` uses `createGraphqlClient` instead. A GraphQL target with a single captured query inlines it as a constant; a read-only GraphQL flow with several 2xx `query` candidates and no `submitStep` instead ranks them by response size, `payloadField` correlation, capture phase, and recurrence to pick the primary data operation; a GraphQL target whose captures form a multi-operation mutation sequence (a submission flow) gets the same state-threaded, multi-step `executeHttp` REST submission flows get.

```ts
// src/sites/my-site/contract.ts
import { z } from "zod/v4";
import { createRateLimitedJsonClient } from "@/scraper/rate-limited-json-client";
import type { BrowserSession } from "@/scraper/session";
import type { SitePlugin, SitePluginContext, SitePluginResult } from "@/site-plugin";
import { runMySiteBrowserFlow } from "@/sites/my-site/flows/browser-flow";

// Generated: Zod schemas inferred from captured JSON — tighten z.unknown() fields as needed.
export const MySiteResponseSchema = z.object({ data: z.object({ items: z.array(z.object({ id: z.string() })) }) });
const MySitePayloadSchema = z.object({ query: z.string().min(1) });

type MySitePayload = z.infer<typeof MySitePayloadSchema>;
type MySiteResponse = z.infer<typeof MySiteResponseSchema>;

// Generated: rate-limit ceiling (5 rps) + Chromium hints + site-specific headers from recon.
// Use createHttpClient() directly only when you need manual Bottleneck or header control.
const httpClient = createRateLimitedJsonClient({
  minTimeMs: 200,
  userAgent: "Mozilla/5.0 ...",
  secChUa: '"Chromium";v="..."',
  platform: "Linux",
  extraHeaders: {
    "Content-Type": "application/json",
    Accept: "application/json, */*",
  },
  schema: MySiteResponseSchema,
});

export const mySitePlugin: SitePlugin<MySitePayload, MySiteResponse> = {
  meta: {
    siteId: "my-site",
    displayName: "My Site",
    bodySchema: MySitePayloadSchema,
    responseSchema: MySiteResponseSchema,
    defaultBaseUrl: "https://my-site.com",
  },
  // Hot path: direct HTTP — no browser, no LLM tokens.
  async executeHttp(payload: MySitePayload, context: SitePluginContext): Promise<SitePluginResult<MySiteResponse>> {
    const data = await httpClient(`${context.baseUrl}/api/search`, {
      method: "POST",
      body: JSON.stringify({ query: payload.query }),
    });
    return { data };
  },
  // Browser fallback: Stagehand + Steel — invoked automatically when hot path fails.
  async execute(payload: MySitePayload, session: BrowserSession, context: SitePluginContext): Promise<SitePluginResult<MySiteResponse>> {
    const raw = await runMySiteBrowserFlow(session.stagehand, context.baseUrl, payload.query);
    return { data: raw };
  },
};
```

## The auditPayload hook

`SitePluginResult` accepts an optional `auditPayload` field alongside `data`:

```ts
return {
  data: responseData,
  auditPayload: { query: payload.query, resultCount: responseData.items.length },
};
```

When `auditPayload` is present, core writes it — not `data` — to the submission-envelope telemetry record. Use this to strip PII or large blobs from the audit trail while keeping the full response in the API reply. When absent, `data` is written as-is.

## Reconciliation join keys (`extractJoinKeys`)

Core has no opinion on what a reconciliation join key is named or how it's
shaped — that's site-specific vocabulary (an attribution vendor's click ID,
a job-reference composition rule, whatever the site needs). A plugin that
needs its submission and beacon-fire telemetry to be joinable back to its own
attribution provider declares an optional `extractJoinKeys` hook on its
`SitePlugin`:

```ts
export const myPlugin: SitePlugin<MyPayload, MyResponse> = {
  extractJoinKeys: (payload) =>
    payload.someVendorClickId ? { vendorClickId: payload.someVendorClickId } : null,
  // ...
};
```

`dispatch()` (`src/plugins/loader.ts`) calls this once per submission,
resolving `extractJoinKeys(payload)` from the inbound payload alone — core
never inspects the result's contents. A plugin with no reconciliation needs
simply omits `extractJoinKeys`.

### Mid-run attach point (`context.telemetry.addJoinKeys`)

`extractJoinKeys` only ever sees the payload a plugin received up front, so
it has no way to attach a field the plugin only discovers *during* the run
— a token minted mid-flow, a value read from the page after navigation, a
value observed on a response. For that, call the mid-run attach point,
`context.telemetry.addJoinKeys()`, from anywhere inside `execute()` or
`executeHttp()`:

```ts
async execute(payload: MyPayload, session, context: SitePluginContext) {
  const mintedToken = await readTokenFromPage(session);
  context.telemetry.addJoinKeys({ mintedToken });
  // ...
},
```

`context.telemetry` is a per-dispatch `RunTelemetry` accumulator
(`src/lib/telemetry/run-telemetry.ts`), constructed fresh for every
dispatch by `buildPluginContext` (`src/plugins/loader.ts`) alongside
`recordBeaconOutcome` below. Successive `addJoinKeys()` calls within the
same run merge, later calls winning on key collision. Once the plugin call
resolves — on both the success and error paths — `dispatch()` snapshots the
accumulator and merges it over the earlier `extractJoinKeys(payload)`
result, run-discovered keys winning on collision, before stamping the
combined bag onto the submission envelope's and beacon-fire record's
`joinKeys` field. `joinKeys` stays `null` only when neither source ever
produced anything.

**A config-only `*.plugin.json` manifest can reach
`context.telemetry.addJoinKeys()` only through the same `spec.httpModule`
escape hatch documented below for `context.recordBeaconOutcome`** —
`executeHttp(payload, context)` receives the same `SitePluginContext`, so an
`httpModule` can call it exactly like `execute()` does above; the
manifest's declarative browser flow cannot, since `runHealingFlow` is
data-driven with no imperative call site for either seam to live in.

**Declaring `extractJoinKeys` also opts the plugin out of core's automatic
`TrackingUrl` fire.** If the site returns a post-submission click-tracking
URL, declare it on the plugin's `bodySchema` by composing `JobTrackingSchema`
(`src/lib/job-tracking.ts`) — `MySitePayloadSchema.extend(JobTrackingSchema.shape)`.
When a plugin has no `extractJoinKeys`, `dispatch()` fires that `TrackingUrl`
itself via `fireTrackingClick`, site-agnostically, after a successful submit.
When a plugin *does* declare `extractJoinKeys`, core assumes the plugin fires
its own post-submit tracking navigation (e.g. because the click and apply
navs must share one browser session for a vendor's device-cookie
attribution to work) and skips its own fire — firing both would open two
independent sessions against the same URL.

By default a self-managing plugin's beacon-fire telemetry is stuck at
`beaconStatus: "skipped"`, since core has no visibility into a navigation the
plugin drives itself. To report the real outcome, call
`context.recordBeaconOutcome` — passed on `SitePluginContext` alongside
`baseUrl`/`logger`/`requestId`, bound to this run — from `execute()`,
`executeHttp()`, or an extra-route handler:

```ts
import type { SitePlugin, SitePluginContext } from "@enricai/barnacle/site-plugin";

export const myPlugin: SitePlugin<MyPayload, MyResponse> = {
  extractJoinKeys: (payload) =>
    payload.someVendorClickId ? { vendorClickId: payload.someVendorClickId } : null,
  async execute(payload, session, context: SitePluginContext) {
    const t0 = Date.now();
    const fired = await runMySiteBeaconNav(session, payload.TrackingUrl);
    await context.recordBeaconOutcome({
      beaconStatus: fired ? "fired" : "failed",
      joinKeys: { vendorClickId: payload.someVendorClickId },
      trackingUrl: payload.TrackingUrl,
      durationMs: Date.now() - t0,
    });
    // ...
  },
};
```

Core binds the run's `requestId` and the plugin's own `siteId` for you, so
`recordBeaconOutcome`'s input carries only `beaconStatus` (`"fired"` |
`"failed"` — `"skipped"` stays an engine-owned outcome), the opaque `joinKeys`
bag (same shape returned from `extractJoinKeys`), and optional `trackingUrl`/
`durationMs`. It never throws — a telemetry-sink hiccup cannot fail the
request. A `fired`/`failed` line recorded this way outranks the automatic
`skipped` line for the same `requestId` when the two are folded together
(see [Telemetry & LLM judging](telemetry-and-judging.md)). A plugin that
never calls it keeps today's unchanged `skipped` default. Import
`BeaconOutcomeInput` from `@enricai/barnacle/site-plugin` if you want to type
the input object explicitly — that's the published subpath an out-of-tree
plugin resolves against its own `node_modules`; in-tree code under `src/`
uses the `@/site-plugin` alias instead.

**A config-only `*.plugin.json` manifest can reach `context.recordBeaconOutcome`
only through the `spec.httpModule` escape hatch** — `executeHttp(payload,
context)` receives the same `SitePluginContext` a module plugin's does, so an
`httpModule` can call it exactly like `execute()` does above. The manifest's
declarative browser flow cannot: `runHealingFlow` is data-driven, with no
imperative call site for a call like this to live in. One consequence to know
before adopting it: `buildConfigPlugin` never synthesizes `extractJoinKeys`,
so a config-only plugin is never `managesOwnTracking` — when the response
carries a `TrackingUrl`, core still fires it itself via `fireTrackingClick`,
and a manifest-recorded `fired`/`failed` line for that `requestId` ranks
equal to core's own line under `beaconRank()`, so the fold resolves by write
order (last line wins) rather than the manifest's line automatically
outranking core's. Only when no `TrackingUrl` is present — so core's own
write is the `skipped` default — does the manifest's recorded line
deterministically outrank it.

## Static fixtures

If Phase 3b (auxiliary fixture detection) found static JSON endpoints (markets, currencies, labels), `recon:generate` copies them to `src/sites/<id>/fixtures/`. Load them at module init via `loadFixture()` — zero per-request overhead, fails fast on deploy if the fixture is missing or stale:

```ts
import { z } from "zod/v4";
import { loadFixture } from "@/scraper/fixtures";

const MarketsSchema = z.array(z.object({ id: z.string(), name: z.string() }));

// Loaded synchronously at module init. Throws at startup if file is missing
// or shape drifted — surface fixture breakage on deploy, not on the first request.
const markets = loadFixture("my-site", "markets.json", MarketsSchema);
```

See [docs/playbook.md — Phase 3b](playbook.md#3b--auxiliary-fixture-detection) for how fixtures are detected and when to use them.

## Register the plugin

**Out-of-tree (recommended for operator-owned plugins):** point `BARNACLE_PLUGINS` at the compiled plugin module — no core edits required:

```bash
BARNACLE_PLUGINS=./plugins/my-site/dist/index.js pnpm start
```

Barnacle validates the export at startup and registers `POST /v1/my-site/run` automatically. See the Out-of-tree plugins env var table (README.md / docs/configuration.md) for `BARNACLE_PLUGINS_STRICT` and `BARNACLE_PLUGINS_DIR`. A copyable, runnable template lives at [`examples/plugins/hello-site/`](../examples/plugins/hello-site/).

**Config-only (no TypeScript, no compile step):** a browser-flow plugin can be a single JSON manifest. Point `BARNACLE_PLUGINS` at a `*.plugin.json` file, or drop manifests into a directory named by `BARNACLE_PLUGINS_CONFIG_DIR`:

```bash
BARNACLE_PLUGINS=./plugins/acme-jobs.plugin.json pnpm start
# or, for directory-drop discovery of every *.plugin.json:
BARNACLE_PLUGINS_CONFIG_DIR=./plugins pnpm start
```

The manifest wears the Kubernetes-style `apiVersion` / `kind` / `metadata` / `spec` envelope, declares its request/response/extract shapes as **JSON Schema**, and lists the browser flow as data (the same self-heal step format the recon toolchain authors). Core reads it at startup and registers `POST /v1/acme-jobs/run` — no per-site code. A site needing the direct-HTTP hot path can reference a compiled `executeHttp` module via `spec.httpModule`. A copyable manifest lives at [`examples/plugins/acme-jobs.plugin.json`](../examples/plugins/acme-jobs.plugin.json).

The JSON Schema converter accepts a deliberately small subset — `object`, `string`, `number`, `integer`, `boolean`, `array` (with `items`), string `enum`, and `required` — and rejects anything else (e.g. `pattern`, `minLength`, `$ref`, `format` constraints) at load time. Flow steps interpolate request values with `{{ .request.FieldName }}`; a reference to a field the request schema does not declare fails loudly, while an optional declared field the caller omits splices as an empty string.

**In-tree (bundled built-ins only):** push to `BUILTIN_SITE_PLUGINS` in `src/plugins/discover.ts`:

```ts
import { mySitePlugin } from "@/sites/my-site";
import { BUILTIN_SITE_PLUGINS } from "@/plugins/discover";

BUILTIN_SITE_PLUGINS.push(mySitePlugin as SitePlugin<unknown, unknown>);
```

Core registers `POST /v1/my-site/run` automatically at startup.

## Wire up the nightly smoke test

Add a step to `.github/workflows/smoke.yml`:

```yaml
- name: Run smoke test — my-site
  if: steps.check-secrets.outputs.skip == 'false'
  run: |
    pnpm run smoke -- \
      --site my-site \
      --payload '{"query":"test"}' \
      --host "$SMOKE_HOST" \
      --fallback \
      --response-schema src/sites/my-site/contract.ts
  env:
    API_KEY: ${{ secrets.SMOKE_API_KEY }}
    SMOKE_HOST: ${{ secrets.SMOKE_HOST }}
    NODE_ENV: production
```

`--response-schema` points to a module whose **default export is a Zod schema**. The smoke test validates the full response body against it — not just the envelope shape — so any schema drift on the data payload fails the pipeline immediately.

`--fallback` additionally runs a second request via the Stagehand browser path. This catches Stagehand cache staleness: if the page DOM changed and the cached selector now points at the wrong element, the hot-path test passes but the fallback test fails — alerting you before the fallback is invoked in production.

## Maintenance loop

When the smoke test fails: re-run `pnpm run recon:browser` → diff `<run-dir>/graphql/*<operationName>*.json` against `src/sites/<id>/contract.ts` → update query / headers / Zod schema → ship. See [docs/playbook.md](playbook.md#phase-6--drift-detection) for the full maintenance loop and change severity table.

---

## Endpoints

Each registered plugin exposes a POST route following the default convention:
`POST /v1/<siteId>/run`. When the hot path detects that required applicant
answers are absent (e.g. Gender, Degree, EducationLevel, SignatureFullName) or
a repeat-applicant OTP challenge, `/run` returns HTTP 200 with
`{ needsUserInfo: true, missingFields: [{ field, question }], requiresOtp }`
instead of a submission result, so the caller can collect the gaps and hand back.

Plugins declare their own extra routes via `meta.extraRoutes`, which core registers
uniformly — the engine has no per-site knowledge. Route paths are declared as
`:siteId` templates, so the concrete path is whatever the plugin's `siteId` is. Two
conventional shapes a plugin may add:

- `POST /v1/<siteId>/resume` — body = the full original candidate payload plus
  `collectedData` (and `otpCode` where the site issues an OTP challenge); re-runs the
  hot path with the collected answers merged in; returns the same `{ verified }`
  envelope as `/run`, or `2007 RESUME_INVALID_OTP` if the OTP is rejected
- `POST /v1/<siteId>/trigger-otp` — body `{ offerId, email }`; asks the target site to
  email an OTP to a repeat applicant; returns `{ success: true }` or a
  `2006 VERIFICATION_TRIGGER_FAILED` error envelope

See `examples/plugins/acme-jobs.plugin.json` for a runnable declaration.

Operational routes:
- `GET /healthz` — liveness probe
- `GET /readyz`  — readiness probe (checks scraper credentials, queue depth)
- `GET /docs`    — Swagger UI (when `ENABLE_DOCS=true`)
- `GET /v1/plugins` — authenticated plugin load report
- `GET /v1/submissions` — authenticated, queryable submit+beacon reconciliation rows (filter by `siteId`, `requestId`, `status`, `beaconStatus`, `from`/`to`; each row also carries the submit session block `session` (`{ id, provider, ip, ipCapturedAt }`) and the beacon-fire `beaconSessionIp`, neither of which is filterable at this layer, same as the opaque `joinKeys` bag; see [Submission-envelope sink](telemetry-and-judging.md#submission-envelope-sink))
