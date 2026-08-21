# Barnacle

Point Barnacle at a site, describe the user flow in plain English, and run three
recon commands. Barnacle drives a real browser through the flow, captures every
API call, replays them with plain HTTP to prove which ones work without a browser,
probes rate-limit ceilings, and generates a complete plugin — Zod schemas
inferred from captured JSON, load-bearing headers, rate-limit ceiling, hot-path
HTTP client, and Stagehand browser fallback. Register the plugin in one line;
Barnacle handles sessions, retries, fallback routing, audit persistence, and
response envelope wrapping.

| Phase | What runs | What you get |
|-------|-----------|--------------|
| **1 — Browser recon** | `pnpm run recon:browser` | Every API call the site makes, captured to `<run-dir>/graphql/*.json` |
| **2–3 — HTTP replay + probing** | `pnpm run recon:http` | Proof each endpoint works without a browser; rate-limit ceiling; static fixtures |
| **4 — Plugin generation** | `pnpm run recon:generate` | A complete plugin: Zod schemas, headers, Bottleneck config, hot-path client, Stagehand fallback |
| **5+ — Runtime** | `pnpm start` | Direct HTTP hot path, automatic browser fallback, nightly smoke test, drift detection |

See [docs/architecture.md](./docs/architecture.md) for the design rationale and
[docs/playbook.md](./docs/playbook.md) for the full step-by-step guide to
adding a new site.

## Usage

### Prerequisites

- Node.js 22+
- pnpm 10.4.1
- A Browserbase account (`BROWSERBASE_API_KEY` + `BROWSERBASE_PROJECT_ID`) for managed browser sessions — the default provider. A Steel account (`STEEL_API_KEY`) is an alternative via `SCRAPER_PROVIDER=steel`
- An Anthropic key (`ANTHROPIC_API_KEY`) for Stagehand's LLM calls, **or** AWS Bedrock (`USE_BEDROCK=true` + AWS credentials) — see [docs/configuration.md](./docs/configuration.md) for details

### Install

```bash
pnpm install
cp .env.example .env   # fill in BROWSERBASE_API_KEY + BROWSERBASE_PROJECT_ID (or STEEL_API_KEY for SCRAPER_PROVIDER=steel) and either ANTHROPIC_API_KEY or Bedrock creds
```

Generating and hashing an API key, plus the full env-var reference, live in
[docs/configuration.md](./docs/configuration.md).

### Dev

```bash
pnpm run dev
```

### Build for production

```bash
pnpm run build
pnpm start
```

### Try it

With the dev server running, confirm it's up:

```bash
curl -s http://localhost:3000/health | jq .
```

Barnacle boots with the built-in plugins registered (see `BUILTIN_SITE_PLUGINS`
in `src/plugins/discover.ts`). Each registered plugin exposes
`POST /v1/<siteId>/run`; every response uses the same envelope shape
(`{ status, ...pluginData }`) so clients share a single parser. See
[docs/plugin-authoring.md#endpoints](./docs/plugin-authoring.md#endpoints)
for the full endpoint reference.

## Commands

| Command | What it does |
|---------|--------------|
| `pnpm run dev` | `tsx watch --env-file=.env src/server.ts` with hot reload |
| `pnpm run build` | compile to `dist/` (tsc + path alias rewriting + copy fixtures) |
| `pnpm start` | `node dist/server.js` |
| `pnpm run typecheck` | strict TS noEmit |
| `pnpm run lint` / `lint:fix` | Biome |
| `pnpm run test` | Vitest unit + integration |
| `pnpm test src/scraper/fixtures.test.ts` | Run a single test file (NEVER use `--` before the filter) |
| `pnpm run test:watch` | Vitest in watch mode |
| `pnpm run test:coverage` | Vitest with v8 coverage report |
| `pnpm run format` | Biome format write |
| `pnpm run recon:browser` | Phase 1 — drive browser + capture API calls |
| `pnpm run recon:http` | Phases 2–3 — replay, introspect, probe rate limits |
| `pnpm run recon:generate -- --site-id <id>` | Phase 4 — generate complete plugin from artifacts |
| `pnpm run recon:summarize -- --site-id <id>` | Phase 4 (optional) — write human-readable findings doc |
| `pnpm run recon:heal -- --site-id <id> --url <url>` | Self-heal a failing recon flow without modifying the source file |
| `pnpm run smoke -- --site <id> --payload '...'` | Phase 6 — run nightly drift-detection smoke test |
| `pnpm run judge:llm -- --calls-ndjson <path> --call-type <type>` | Score captured LLM calls on a three-dimensional rubric |
| `pnpm run heal:llm -- --verdict-path <path> --call-type <type>` | Self-heal a failing prompt template |

## Writing a plugin

A site plugin is a single TypeScript module that satisfies `SitePlugin<TInput, TOutput>`
from `src/site-plugin.ts` — a `meta` block, an optional `executeHttp` hot path, and a
Stagehand `execute` fallback. `pnpm run recon:generate` writes this structure for you.
Plugins can also be config-only JSON manifests with no TypeScript at all. Full
reference in [docs/plugin-authoring.md](./docs/plugin-authoring.md).

## Reference

- Coding standards: [CLAUDE.md](./CLAUDE.md)
- Architecture & design rationale: [docs/architecture.md](./docs/architecture.md)
- Recon playbook (step-by-step): [docs/playbook.md](./docs/playbook.md)
- Configuration (all env vars, deployment, common issues): [docs/configuration.md](./docs/configuration.md)
- Plugin authoring guide: [docs/plugin-authoring.md](./docs/plugin-authoring.md) (runnable example: [examples/plugins/hello-site/](./examples/plugins/hello-site/README.md))
- Testing guide: [docs/testing.md](./docs/testing.md)
- Security policy & vulnerability reporting: [SECURITY.md](./SECURITY.md)
- Telemetry & LLM judging concept guide: [docs/telemetry-and-judging.md](./docs/telemetry-and-judging.md)
- Submission reconciliation runbook: [docs/submission-reconciliation.md](./docs/submission-reconciliation.md)
- Per-site recon findings: [docs/target-recon.md](./docs/target-recon.md) (populated after first `pnpm run recon:summarize`)

## License

[MIT](./LICENSE) © Enricai

Contributions welcome — see [CONTRIBUTING.md](./CONTRIBUTING.md).
