# hello-site — out-of-tree Barnacle plugin example

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

On boot you'll see:

```
hello-site → /v1/hello-site/run (loaded)
```

Then call it (Barnacle routes are authenticated — send a plaintext key whose
bcrypt hash is in `API_KEYS_HASHED`, or set `DEV_BYPASS_AUTH=true` in dev). The
server listens on `http://localhost:3000` by default (`PORT` to override):

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

The authenticated introspection route lists every loaded plugin:

```bash
curl -s http://localhost:3000/v1/plugins -H "Authorization: Bearer <your-api-key>"
```

## Things to know when writing your own

- **Import Zod as `zod/v4`, not bare `zod`.** Barnacle uses
  `fastify-type-provider-zod`, which compiles routes against core's own Zod
  instance. A schema built against a different Zod import may pass load-time
  validation but fail at route registration.
- **Export the plugin as `plugin` and/or `default`** — Barnacle reads
  `module.exports.plugin`, then `.default`, then the module itself. An
  arbitrarily-named export (e.g. `export const myPlugin`) will **not** be found.
- **`apiVersion` must be a plain version like `"1.0.0"`**, not a caret range
  (`"^1.0.0"`). v1 matches the leading major version only; a `^` prefix is not
  parsed and would disable the plugin. (Caret ranges arrive in a later release.)
  You can also omit `apiVersion` entirely to accept any version.
- **Ship binary assets `__dirname`-relative**: `path.join(__dirname, "fixtures", …)`.
  cwd-relative paths break depending on where the server is launched.
- **A plugin that manages its own post-submit tracking navigation must call
  `context.recordBeaconOutcome`** — otherwise its beacon-fire telemetry stays
  stuck at `beaconStatus: "skipped"`. A config-only `*.plugin.json` manifest
  can reach it too, but only through the `spec.httpModule` escape hatch —
  `executeHttp(payload, context)` receives the same `SitePluginContext` a
  module plugin's does. See the repository README's
  [Reconciliation join keys](../../../README.md#reconciliation-join-keys-extractjoinkeys)
  section for the full contract, including the fold-precedence consequence
  of adopting it.
- **To attach a field only discovered mid-run** (something read off the page
  after navigation, a token minted mid-flow, a value observed on a response —
  anything `extractJoinKeys` can't see because it only ever runs against the
  pre-run payload), call `context.telemetry.addJoinKeys({ ... })` from
  `execute()` or `executeHttp()` at any point before returning. Core merges
  the collector's snapshot over `extractJoinKeys(payload)`'s result before
  writing the submission's `joinKeys` bag — run-discovered keys win on
  collision. See the same
  [Reconciliation join keys](../../../README.md#reconciliation-join-keys-extractjoinkeys)
  section for the full contract.
- **Config-only `*.plugin.json` manifests can only reach `context.telemetry`
  through the `httpModule` escape hatch.** `executeHttp(payload, context)`
  receives the same `SitePluginContext` a module plugin's does, so a manifest
  with an `httpModule` can call `addJoinKeys()` from it. The manifest's own
  declarative browser flow cannot — it's driven entirely by data through
  `runHealingFlow`, with no imperative per-site code for a call like this to
  live in.

See the repository README's **Out-of-tree plugins** section for the full
`BARNACLE_PLUGINS` / `BARNACLE_PLUGINS_STRICT` / `BARNACLE_PLUGINS_DIR` env-var
reference and the resolution/failure-policy rules.
