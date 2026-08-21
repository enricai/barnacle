# Configuration

Environment variables, deployment, and troubleshooting reference for Barnacle.

## Environment variables

All variables are read once at process start. Required variables cause the
process to exit on missing values; optional ones have safe defaults.

### Application

| Variable | Default | Required | Purpose |
|----------|---------|----------|---------|
| `APP_NAME` | `barnacle` | No | Application name used in logs |
| `NODE_ENV` | `development` | No | `development` / `production` / `test` |
| `PORT` | `3000` | No | HTTP listen port |
| `HOST` | `0.0.0.0` | No | HTTP listen address |
| `LOG_LEVEL` | `info` | No | Pino log level (`debug`, `info`, `warn`, `error`) |

### Auth

| Variable | Default | Required | Purpose |
|----------|---------|----------|---------|
| `API_KEYS_HASHED` | `""` | Yes (prod) | Comma-separated bcrypt hashes of plaintext bearer tokens. See [Generating an API key](#generating-an-api-key). |
| `DEV_BYPASS_AUTH` | `false` | No | Skip auth entirely. Local dev only — **never set in production**. |

### Browser automation (Steel + Stagehand)

| Variable | Default | Required | Purpose |
|----------|---------|----------|---------|
| `STEEL_API_KEY` | — | **Yes** | Steel account API key. Required for all browser automation. |
| `ANTHROPIC_API_KEY` | — | Yes (if not using Bedrock) | Anthropic API key for Stagehand's LLM calls. |
| `STAGEHAND_MODEL` | `anthropic/claude-sonnet-4-6` | No | Stagehand model. Use the `anthropic/` prefix — Stagehand 2.x's model map is stale and the prefix routes through AI-SDK's fallback path. |
| `SCRAPER_PROXY_TYPE` | `residential` | No | `residential` (paid Steel tiers) or `none` (free tier — Steel rejects `useProxy=true` on hobby plans). |
| `SCRAPER_SOLVE_CAPTCHA` | `true` | No | Enable Steel's built-in CAPTCHA solver. Requires a paid plan; set `false` on the free tier. |
| `SESSION_POOL_SIZE` | `3` | No | Maximum concurrent Steel browser sessions. |
| `SCRAPER_MIN_ACTION_DELAY_MS` | `500` | No | Minimum delay between scraper actions (ms). Jitter applied on top. |
| `SCRAPER_MAX_ACTION_DELAY_MS` | `1500` | No | Maximum delay between scraper actions (ms). |
| `STAGEHAND_API_TIMEOUT_MS` | `120000` | No | Anthropic SDK request timeout (ms). Raise on slow network paths to `api.anthropic.com`. |
| `STAGEHAND_CONNECT_TIMEOUT_MS` | `120000` | No | TCP connect timeout for all outbound fetch calls (ms). Raised from the undici default of 10 s to match `STAGEHAND_API_TIMEOUT_MS`. |
| `STEEL_SESSION_TIMEOUT_MS` | `3600000` | No | Steel session wall-clock timeout (ms). Default is 1 hour; lower on plans that enforce shorter maximum session durations. |
| `FRAME_READY_TIMEOUT_MS` | `20000` | No | How long `resolveFrameTarget` polls for a child iframe to attach before falling back to the main frame (ms). Raise further for cross-origin OOPIFs that attach slowly under advancedStealth + proxied CDP. |
| `FRAME_DOCUMENT_READY_TIMEOUT_MS` | `5000` | No | How long `waitForChildFrameReady` polls a resolved child frame's `document.readyState` before proceeding anyway (ms). Independent of `FRAME_READY_TIMEOUT_MS` — this wait settles in well under a second once attached. |
| `FRAME_EVALUATE_TIMEOUT_MS` | `30000` | No | Watchdog budget for a single frame-scoped evaluate/candidate-probe call (ms), so a call against a racy frame fails the attempt instead of hanging indefinitely. |
| `FRAME_PRESENCE_PROBE_FLOOR_MS` | `3000` | No | Per-probe watchdog floor for `probeAttachedFrameTarget`'s single non-polling presence check (ms) — a real budget a genuine CDP round-trip can land within, instead of the `timeoutMs: 0` zero-budget pattern that always loses that race. |
| `SCRAPER_CAPTURE_SESSION_IP` | `true` | No | Master switch for the outbound-IP echo navigation; `false` yields `session: null` / `sessionIp: null` everywhere without touching the rest of the submit/beacon record. |
| `SCRAPER_SESSION_IP_ECHO_URL` | `https://api.ipify.org?format=json` | No | The IP-echo endpoint the session's own short-lived tab navigates to. Operators can point this at a self-hosted echo endpoint. |
| `SCRAPER_SESSION_IP_TIMEOUT_MS` | `10000` | No | Watchdog bound on the echo navigation; a page that never resolves is cut off and yields `null` rather than blocking the submission. |

### AWS Bedrock (alternative LLM provider)

Set `USE_BEDROCK=true` to route Stagehand's LLM calls through AWS Bedrock
instead of the Anthropic API. When enabled, `ANTHROPIC_API_KEY` is not needed.
AWS credentials resolve in standard SDK order: explicit vars → ECS task role →
EC2 instance profile → `~/.aws/credentials`.

| Variable | Default | Required | Purpose |
|----------|---------|----------|---------|
| `USE_BEDROCK` | `false` | No | Master switch — routes LLM calls through Bedrock when `true`. |
| `AWS_REGION` | `us-east-1` | No | AWS region for Bedrock calls. |
| `AWS_ACCESS_KEY_ID` | — | No | Explicit AWS access key (leave blank for ambient IAM). |
| `AWS_SECRET_ACCESS_KEY` | — | No | Explicit AWS secret key. |
| `AWS_SESSION_TOKEN` | — | No | Required only for temporary STS credentials. |
| `BEDROCK_MODEL` | `us.anthropic.claude-sonnet-4-6[1m]` | No | Bedrock cross-region inference profile ID. The `us.` prefix enables automatic cross-region routing; the `[1m]` suffix selects the 1M-token context variant. |

### Cache

| Variable | Default | Purpose |
|----------|---------|---------|
| `CACHE_TTL_MS` | `900000` (15 min) | LRU response cache TTL. Cached responses skip the target API entirely. |
| `CACHE_MAX_ENTRIES` | `1000` | Maximum entries in the LRU cache. |

### Rate limiting (inbound)

These limit traffic *to* Barnacle's own API. See per-plugin Bottleneck config
in each `contract.ts` for outbound rate limits to target sites.

| Variable | Default | Purpose |
|----------|---------|---------|
| `RATE_LIMIT_MAX` | `120` | Max requests per window per API key (or IP for unauthenticated traffic). |
| `RATE_LIMIT_WINDOW_MS` | `60000` (1 min) | Rate limit window duration. |
| `TRUST_PROXY` | `true` | Trust `X-Forwarded-For` when behind a reverse proxy. Set `false` for bare-metal deploys to prevent spoofing. |

### Readiness / observability

| Variable | Default | Purpose |
|----------|---------|---------|
| `READINESS_QUEUE_THRESHOLD` | `20` | `/readyz` returns 503 when scraper queue depth exceeds this. Lets orchestrators shed load before the pool is saturated. |
| `ENABLE_DOCS` | `false` | Serve Swagger UI at `/docs`. Disable in production. |

### Datadog (opt-in)

APM tracing and DogStatsD metrics are **opt-in**: `dd-trace` and `hot-shots` are
optional peer dependencies, so a plain `npm i @enricai/barnacle` installs neither
and Barnacle runs without them. Enable either half independently — install the
package and flip its flag. If a flag is on but the package is missing, Barnacle
warns and carries on with that feature disabled; it never fails to boot.

```bash
# APM tracing
pnpm add dd-trace
DD_TRACE_ENABLED=true node --import dd-trace/initialize dist/server.js

# DogStatsD metrics
pnpm add hot-shots
DD_METRICS_ENABLED=true node dist/server.js
```

Tracing needs `--import dd-trace/initialize` for full auto-instrumentation:
Datadog requires the tracer to load before any other module so it can patch
http/net/dns. Metrics have no such constraint.

| Variable | Default | Purpose |
|----------|---------|---------|
| `DD_TRACE_ENABLED` | `false` | Enable APM tracing. Requires the `dd-trace` peer dependency. |
| `DD_METRICS_ENABLED` | `false` | Enable DogStatsD metrics. Requires the `hot-shots` peer dependency. Independent of `DD_TRACE_ENABLED`. |
| `DD_AGENT_HOST` | `localhost` | Datadog agent hostname (the sidecar, in ECS Fargate). |
| `DD_DOGSTATSD_PORT` | `8125` | DogStatsD UDP port on the agent host. |
| `DD_SERVICE` | `barnacle` | Service name tagged on spans and metrics. |
| `DD_ENV` | `NODE_ENV` | Deployment environment tag. |
| `DD_VERSION` | `0.1.0` | Application version tag — git SHA or package version. |

### Telemetry

| Variable | Default | Purpose |
|----------|---------|---------|
| `TELEMETRY_ENABLED` | `true` | Master switch — set `false` to disable all NDJSON telemetry writes. |
| `TELEMETRY_EVENTS_DIR` | `.barnacle/events` | Directory for per-run NDJSON event stream files (`<eventsDir>/<runId>.ndjson`). |
| `CALLS_NDJSON_PATH` | `.barnacle/calls.ndjson` | Append-only NDJSON sink for LLM/Stagehand call samples. One line per call; feed to the judge and self-heal skills. |
| `SUBMISSIONS_NDJSON_PATH` | `.barnacle/submissions.ndjson` | Append-only NDJSON sink for dispatch submission envelopes and beacon-fire outcomes. `kind:"submit"` lines (null/`"submit"`-defaulted on legacy lines) capture siteId, requestId, inbound payload, status, audit payload, and duration, plus the opaque `joinKeys` bag a plugin's `extractJoinKeys` hook resolved, merged with anything attached mid-run via `context.telemetry.addJoinKeys()` — the durable source-of-truth for "what did we submit for jobId X and did it succeed." `kind:"beacon"` lines record a later (or, for `beaconStatus: "skipped"`, immediate) independent beacon-fire outcome (`beaconStatus`: `fired`/`failed`/`skipped`, truncated `trackingUrl`) for the same `requestId`, so "submitted but the beacon did not fire" is measurable — the `skipped` line is always written by `dispatch()` itself, but a plugin managing its own tracking nav can call `context.recordBeaconOutcome` to append a real `fired`/`failed` line for the same `requestId`, which outranks `skipped` when the two are folded (see [Reconciliation join keys](./submission-reconciliation.md)). A reader folds both kinds together by `requestId`, so a plugin can join runs to its own attribution provider's report without re-parsing `inboundPayload`. |
| `TELEMETRY_MAX_FILE_SIZE_BYTES` | `104857600` (100 MB) | Rotate/drop the calls NDJSON once it exceeds this byte count. |
| `TELEMETRY_MAX_RETENTION_MS` | `2592000000` (30 days) | Drop event-stream files older than this many milliseconds. |
| `TELEMETRY_S3_BUCKET` | — | Optional — destination bucket for the buffered S3 telemetry replica. Sink is entirely inert (no client, no network calls) when unset. Credentials/region resolve the same way as Bedrock (`AWS_REGION`, standard SDK credential order). |
| `TELEMETRY_S3_PREFIX` | `telemetry` | Key prefix for uploaded NDJSON objects (`<prefix>/<calls\|submissions>/<date>/...`). |
| `TELEMETRY_S3_FLUSH_INTERVAL_MS` | `60000` | How often buffered lines are flushed to S3. |
| `TELEMETRY_S3_MAX_BUFFER_LINES` | `500` | Threshold-flush trigger — flush early if either buffer exceeds this many lines, ahead of the next scheduled interval. |
| `TELEMETRY_S3_READ_MAX_OBJECTS` | `200` | Upper bound on the number of S3 objects a single reconciliation read-path query is allowed to scan. |
| `TELEMETRY_S3_READ_CONCURRENCY` | `8` | Max concurrent object fetches for a single reconciliation read-path query. |

### LLM judging

| Variable | Default | Purpose |
|----------|---------|---------|
| `JUDGE_MODEL` | `us.anthropic.claude-sonnet-4-6[1m]` | Anthropic model used by the judge script. Reuses Bedrock creds via the cross-region inference profile. |
| `JUDGE_TEMPERATURE` | `0.2` | Sampling temperature for judge LLM calls. Keep low (≤ 0.3) for deterministic verdicts. |
| `JUDGE_BATCH_SIZE` | `10` | Number of call samples sent to the judge in one LLM request. |
| `JUDGE_TIMEOUT_MS` | `120000` (2 min) | Anthropic SDK request timeout for judge calls. |

### Self-heal

| Variable | Default | Purpose |
|----------|---------|---------|
| `SELFHEAL_MAX_ITERATIONS` | `5` | Maximum patch→replay→score iterations before BUDGET_EXHAUSTED. |
| `SELFHEAL_N_REPLAYS` | `5` | Number of replay runs per iteration arm. |
| `SELFHEAL_SUCCESS_THRESHOLD` | `0.9` | Minimum pass rate (0–1) to declare SUCCESS and stop iterating. |
| `SELFHEAL_PLATEAU_WINDOW` | `3` | Consecutive iterations below `SELFHEAL_PLATEAU_DELTA` that triggers PLATEAUED. |
| `SELFHEAL_PLATEAU_DELTA` | `0.03` | Minimum absolute pass-rate improvement per iteration to count as progress. |
| `SELFHEAL_TIMEOUT_MS` | `60000` (1 min) | Per-replay LLM request timeout. |

### Per-site base URL overrides

Set `BARNACLE_SITE_<UPPERCASE_SITE_ID>_BASE_URL` to override a plugin's
`defaultBaseUrl` without source changes. Underscores in the env key map to
hyphens in the `siteId`:

```bash
BARNACLE_SITE_MY_SHOP_BASE_URL="https://staging.my-shop.com"  # overrides plugin `my-shop`
```

### Out-of-tree plugins

| Variable | Default | Purpose |
|----------|---------|---------|
| `BARNACLE_PLUGINS` | `""` | Comma-separated list of plugin specifiers to load at startup — relative paths (`./plugins/acme`) or package names (`@acme/barnacle-plugin`). Empty by default (built-ins only). |
| `BARNACLE_PLUGINS_STRICT` | `false` | When `true`, any plugin that fails to load aborts the process instead of producing a disabled record. |
| `BARNACLE_PLUGINS_DIR` | `process.cwd()` | Base directory used to resolve relative specifiers and locate the operator's `node_modules`. Defaults to wherever the binary is run — not the installed Barnacle package root. |
| `BARNACLE_PLUGINS_CONFIG_DIR` | _(unset)_ | Directory scanned at startup for `*.plugin.json` config manifests, each loaded as a config-only plugin. Lets operators register sites by dropping a JSON file in a directory instead of editing `BARNACLE_PLUGINS`. An unreadable directory is logged and skipped — it never crashes boot. |

**Resolution rule:** a specifier starting with `.` or `/` is treated as a filesystem path resolved relative to `BARNACLE_PLUGINS_DIR`. Anything else is treated as an npm package name and resolved via `require.resolve` against the operator's own `node_modules` inside `BARNACLE_PLUGINS_DIR`.

**Failure policy:** by default (non-strict), a plugin that fails to load is logged at `warn` level and recorded as `"disabled"` in the load report — the server still boots with the remaining plugins. Set `BARNACLE_PLUGINS_STRICT=true` to abort startup on any load failure instead.

**`zod/v4` requirement for plugin authors:** import Zod as `import { z } from "zod/v4"` in your plugin, not as bare `"zod"`. Barnacle uses `fastify-type-provider-zod` which compiles routes against core's own zod instance; a plugin schema built against a different zod import may pass load-time validation but fail at route registration.

`GET /v1/plugins` (authenticated) returns the full plugin load report — one record per built-in and out-of-tree specifier — including `siteId`, `displayName`, `route`, `specifier`, `resolvedPath`, `apiVersion`, `status` (`"loaded"` or `"disabled"`), and an optional `reason` when disabled. Requires a valid `Authorization: Bearer <token>` header (reveals filesystem paths, so it is separate from the auth-free `/healthz`/`/readyz` probes).

### Generating an API key

Barnacle validates every request using bcrypt-hashed bearer tokens stored in
`API_KEYS_HASHED`. To create one:

```bash
# 1. Generate a random plaintext key — save this, you'll send it as Authorization: Bearer <key>
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# 2. Hash it (bcrypt cost factor 10) — paste the output into API_KEYS_HASHED
node -e "const b=require('bcryptjs');b.hash(process.argv[1],10,(e,h)=>console.log(h))" <your-key>
```

Comma-separate multiple hashes in `API_KEYS_HASHED` to support key rotation.

For local development, set `DEV_BYPASS_AUTH=true` in `.env` to skip auth
entirely — never set this in production.

## Deployment

### Production checklist

```bash
# .env (production)
NODE_ENV=production
ENABLE_DOCS=false         # never expose Swagger in prod
TRUST_PROXY=true          # set false if deploying directly to the internet (no ALB/nginx)
DEV_BYPASS_AUTH=false     # this is the default — confirm it's not set to true
API_KEYS_HASHED="<bcrypt-hash>,<bcrypt-hash>"  # at least one key
STEEL_API_KEY="..."
ANTHROPIC_API_KEY="..."   # or USE_BEDROCK=true + AWS creds
```

### Process management

Barnacle is a plain Node.js process. Use pm2 or systemd to keep it alive and
restart it on crash:

```bash
# pm2
pm2 start dist/server.js --name barnacle --env production
pm2 save && pm2 startup

# systemd (example unit)
[Service]
ExecStart=/usr/bin/node /srv/barnacle/dist/server.js
WorkingDirectory=/srv/barnacle
EnvironmentFile=/srv/barnacle/.env
Restart=on-failure
```

### Reverse proxy

Route traffic through nginx or an Application Load Balancer (ALB). Set
`TRUST_PROXY=true` so Fastify uses `X-Forwarded-For` for the client IP
(needed for rate limiting on unauthenticated traffic).

```nginx
location / {
    proxy_pass         http://127.0.0.1:3000;
    proxy_set_header   X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header   X-Forwarded-Proto $scheme;
    proxy_set_header   Host $host;
}
```

### Health probes

Wire `/healthz` as the liveness probe and `/readyz` as the readiness probe:

```yaml
# Kubernetes example
livenessProbe:
  httpGet: { path: /healthz, port: 3000 }
  initialDelaySeconds: 5
readinessProbe:
  httpGet: { path: /readyz, port: 3000 }
  initialDelaySeconds: 10
```

`/readyz` returns 503 when the scraper pool queue is saturated (depth >
`READINESS_QUEUE_THRESHOLD`) or when required scraper credentials are missing.

## Common issues

| Symptom | Cause | Fix |
|---------|-------|-----|
| `Error: STEEL_API_KEY is required` | Missing env var | Add `STEEL_API_KEY` to `.env` |
| `useProxy rejected` / `402` from Steel | Free-tier plan doesn't support residential proxies | Set `SCRAPER_PROXY_TYPE=none` and `SCRAPER_SOLVE_CAPTCHA=false` |
| `401 Unauthorized` on every request | No API key configured or wrong plaintext key | Verify `API_KEYS_HASHED` is set; double-check the plaintext key. For dev, set `DEV_BYPASS_AUTH=true` |
| Stagehand throws `model not found` | Wrong model name format | Use the `anthropic/` prefix: `STAGEHAND_MODEL=anthropic/claude-sonnet-4-6` |
| `/readyz` returns 503 on `scraperCredentials` | `STEEL_API_KEY` or LLM key missing | Set the missing credential |
| Build succeeds but `dist/sites/` is empty | `tsc` ran but `cp -r src/sites dist/sites` was skipped | Run `pnpm run build` (not `tsc` directly) — the build script copies site sources after compilation |
