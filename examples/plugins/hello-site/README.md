# hello-site — out-of-tree Barnacle plugin example

Barnacle turns any website into an API, and a `SitePlugin` is how you teach it a new one.
A minimal, runnable [`SitePlugin`](../../../src/site-plugin.ts) you can copy as a
starting point for your own out-of-tree plugin. The stock Barnacle server
discovers, validates, and registers it at startup from the `BARNACLE_PLUGINS`
env var — **no core edits required**.

## Build

```bash
cd examples/plugins/hello-site
pnpm install
pnpm build          # tsc → dist/index.js + dist/index.d.ts
```

The plugin ships as **compiled JS + `.d.ts`** (in `dist/`), not TypeScript
source — Barnacle loads the compiled module via `import()`.

## Run it against Barnacle

From the repository root:

```bash
BARNACLE_PLUGINS=./examples/plugins/hello-site/dist/index.js pnpm start
```

Then call it (Barnacle routes are authenticated — send a plaintext key whose
bcrypt hash is in `API_KEYS_HASHED`, or set `DEV_BYPASS_AUTH=true` in dev):

```bash
curl -s -X POST http://localhost:3000/v1/hello-site/run \
  -H "Authorization: Bearer <your-api-key>" \
  -H "content-type: application/json" \
  -d '{"name":"world"}'
```

```json
{
  "status": { "httpStatus": "OK", "dateTime": "…", "details": [] },
  "greeting": "hello, world",
  "metrics": { "…": "…" }
}
```

## Writing your own

For the full authoring contract — Zod import rules, plugin export shape,
`apiVersion` matching, `context.recordBeaconOutcome`, and
`context.telemetry.addJoinKeys()` — see the
[plugin-authoring guide](../../../docs/plugin-authoring.md) and the
[configuration guide's **Out-of-tree plugins**](../../../docs/configuration.md#out-of-tree-plugins)
section for the `BARNACLE_PLUGINS*` env-var reference.
