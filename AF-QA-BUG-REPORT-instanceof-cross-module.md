# Bug report: out-of-tree plugins' custom error classes fail `dispatch()`'s `instanceof` checks

## Summary

`dispatch()` in `src/plugins/loader.ts` identifies plugin-thrown control-flow
errors (hot-path-to-browser fallback, rate-limit/url-lock telemetry, error
classification) via `instanceof` against barnacle's own local error classes
in `src/scraper/errors.ts`. An out-of-tree plugin built the officially
documented way — its own `package.json` depending on `@enricai/barnacle` and
importing these error classes from that independently-resolved npm copy —
throws an error object that is `instanceof` a *different* class than the one
`loader.ts` checks against, even when both copies report the identical
package version. The check silently evaluates to `false`, and the intended
fallback/telemetry/classification behavior never triggers.

This was found while building and live-testing an out-of-tree plugin
(`aidfinder-fema`, in the sibling `af-qa` repo) against a local barnacle
server (`pnpm dev`).

## Reproduction

1. In `af-qa`, build the plugin: `pnpm build` (emits
   `dist/fema/aidfinder-fema/index.js`).
2. Start barnacle with it loaded:
   ```sh
   BARNACLE_PLUGINS=/path/to/af-qa/dist/fema/aidfinder-fema/index.js pnpm dev
   ```
3. POST a scenario payload that the plugin's `executeHttp` deliberately
   rejects with `HttpSchemaError` to signal "no HTTP hot path for this
   scenario, fall back to browser execution" (a real, documented pattern —
   see `af-qa`'s `contract.ts` around the `executeHttp` method):
   ```sh
   curl -X POST http://localhost:3000/v1/aidfinder-fema/run \
     -H 'Authorization: Bearer <key or DEV_BYPASS_AUTH=true>' \
     -H 'Content-Type: application/json' \
     -d '{"scenario":"invalid_input","baseUrl":"https://stg.aidfinder.com","locationId":"qa-recon"}'
   ```

## Observed vs. expected

**Observed**: `500 INTERNAL_SERVER_ERROR` returned in ~18ms (too fast to
have attempted anything past the schema-rejection throw). Server log shows:

```
err: {
  "type": "HttpSchemaError",
  "message": "scenario \"invalid_input\" has no HTTP hot path — browser-only assertion",
  "stack":
      HttpSchemaError: scenario "invalid_input" has no HTTP hot path — browser-only assertion
          at Object.executeHttp (.../dist/fema/aidfinder-fema/contract.js:725:19)
          at <anonymous> (.../barnacle/src/plugins/loader.ts:199:20)
          at getOrCreateInFlight (.../barnacle/src/cache/response-cache.ts:112:19)
          at runPluginPipeline (.../barnacle/src/plugins/loader.ts:196:25)
          at dispatch (.../barnacle/src/plugins/loader.ts:348:26)
  ...
}
```

The error reaches `dispatch()`'s `catch (httpErr)` block, but none of the
`instanceof` branches match, so it falls through to the final `throw httpErr`
at the bottom of the catch block (`loader.ts:240` in the current tree) and
surfaces as an unhandled 500.

**Expected** (per the code's own design, and per `af-qa`'s `contract.ts`
comments describing the contract it's relying on): barnacle should log
`hot path failed for aidfinder-fema (HttpSchemaError): ... — engaging browser
fallback`, then invoke `plugin.execute(payload, session, context)` via
`runWithSession`.

## Root cause

Two distinct `HttpSchemaError` **class objects**, from two separate module
resolution trees, both reporting package version `1.7.3` — this is not a
version-skew problem a version bump would fix:

- **Barnacle's own class**: `src/scraper/errors.ts:164` (this checkout):
  ```ts
  export class HttpSchemaError extends ScraperError {
    constructor(message = "http response schema mismatch") {
      super(message, false);
    }
  }
  ```
  Imported into `loader.ts` from this same source tree and checked at
  `loader.ts:206`:
  ```ts
  if (
    httpErr instanceof HttpSchemaError ||
    httpErr instanceof HttpBotChallengeError ||
    httpErr instanceof HttpServerError
  ) { ... }
  ```

- **The plugin's class**: `af-qa/src/fema/aidfinder-fema/contract.ts:15`:
  ```ts
  import { HttpSchemaError } from "@enricai/barnacle/scraper/errors";
  ```
  This resolves through `af-qa`'s own `package.json`
  (`"@enricai/barnacle": "^1.7.3"`) to a separately npm-installed,
  independently compiled copy at
  `af-qa/node_modules/.pnpm/@enricai+barnacle@1.7.3.../node_modules/@enricai/barnacle/dist/scraper/errors.js`
  — a different file on disk, loaded into a different position in Node's
  module registry than this checkout's own `src/scraper/errors.ts`.

Confirmed directly (not inferred) via `require.resolve('@enricai/barnacle/scraper/session')`
run from each project's own directory: they resolve to two different
absolute paths. `class X extends Y {}` produces a nominally distinct
constructor per module instantiation in Node's module system — `instanceof`
compares prototype identity, not structural/version equality, so this holds
regardless of whether the two `@enricai/barnacle` copies are byte-for-byte
identical.

## Blast radius — every `instanceof` check against a barnacle-defined error class in `loader.ts`

Not limited to the 3 that gate hot-path-to-browser fallback. Any out-of-tree
plugin that imports and throws these classes (which is the officially
documented way to signal these conditions from a plugin) hits the same
silent mismatch:

| `loader.ts` location | Checks | Effect when the thrown error is from a plugin's independently-resolved copy |
|---|---|---|
| `~206-208` | `HttpSchemaError`, `HttpBotChallengeError`, `HttpServerError` | Browser fallback never triggers — this bug's reproduction above |
| `~228` | `HttpRateLimitError` | Rate-limit telemetry (`recordRateLimitRejection`/`recordDdRateLimit`) silently skipped |
| `~235` | `HttpUrlLockedError` | URL-locked telemetry/warning silently skipped |
| error-classification helper (labels failures for logs/dashboards, e.g. `"schema_drift"`, `"bot_challenge"`) | `HttpBotChallengeError`, `HttpRateLimitError`, `HttpUrlLockedError`, `HttpSchemaError`, `HttpServerError`, `CaptchaError`, `EmptyResultsError`, `ScraperError` | Falls through to an unknown/default label instead of the correct classification |
| wire-error translation near the top of `loader.ts` (`~82-86`) | `CaptchaError`, `EmptyResultsError`, `HttpRateLimitError`, `HttpUrlLockedError`, `ScraperError` | Fails to map to the intended API error envelope (`CaptchaEncounteredError`, `ThrottledRequestError`, etc.), so callers get a generic/wrong error shape |

This affects **any** out-of-tree plugin built per barnacle's own documented
pattern (a separate package depending on `@enricai/barnacle`), not just
`aidfinder-fema`.

## What we're not proposing

Not suggesting duck-typing, shared symbols, a re-exported factory, or any
other specific approach — how to fix the cross-module identity problem is
your call, not something we want to prescribe from outside. Flagging this
because it's a real, currently-live gap for any consumer of barnacle's
out-of-tree plugin model, and because it silently degrades correctness
(500s instead of graceful fallback) rather than failing loudly.

## Related, secondary finding (same failure family, already worked around downstream)

Separately, we also hit `InvalidArgumentError: invalid content-length
header` from `@browserbasehq/sdk` inside a plugin-initiated browser session
(a plugin calling `createBrowserSession()` directly rather than going
through barnacle's own session pool). This checkout already has a fix for
that exact issue — `patches/@browserbasehq__sdk.patch` +
`patchBrowserbaseContentLengthHeader()` in `src/lib/http.ts` — but it's
applied to *this checkout's own* resolved copy of the SDK via
`pnpm.patchedDependencies`, which (same root cause as above) never reaches
a plugin's independently-installed copy of `@browserbasehq/sdk`. We worked
around this on our own side by re-applying the identical monkeypatch inside
our plugin's code, so no action needed here — just noting it as a second
data point of the same underlying pattern: fixes/patches applied to
barnacle's own resolved dependency tree don't propagate to an out-of-tree
plugin's independently-resolved copy of the same package.
