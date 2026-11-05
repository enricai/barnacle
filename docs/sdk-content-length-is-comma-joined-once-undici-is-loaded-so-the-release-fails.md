# The SDK's `content-length` is comma-joined once undici is loaded, so the release fails

A `keepAlive: true` session is freed only by an explicit `REQUEST_RELEASE`, and until it
is freed it bills — 90 min at our configured session timeout. That release goes through
`@browserbasehq/sdk`'s `sessions.update`, and in any entry point that has not run
`configureHttpDispatcher()` it fails outright, so every session that entry point creates
leaks.

## The mechanism

The SDK sets an explicit `content-length` header, then hands the request to Node's
`fetch`. Once undici is loaded in the process, undici's dispatcher handles that fetch,
and its `Request` constructor folds the caller-supplied header together with its own
computed value into a comma-joined string. Captured at the dispatcher:

```
OUTGOING headers: {"content-length":"53, 53","accept":"application/json", …}
ERR: Connection error. <- fetch failed <- invalid content-length header
```

```
APIConnectionError: Connection error.
  cause: TypeError: fetch failed
    cause: InvalidArgumentError: invalid content-length header
      at processHeader (undici/lib/core/request.js:540:13)
      at new Request (undici/lib/core/request.js:269:11)
```

`isValidContentLengthHeaderValue` (`undici/lib/core/request.js:31`) accepts digit
characters only, so the comma fails validation. The SDK wraps the result as a bare
`Connection error.`, which is why this reads as a transient network fault in logs.

**Merely importing undici is enough.** `setGlobalDispatcher` is not the trigger:

| setup | result |
|---|---|
| SDK alone, undici never loaded | request reaches the API (401 on a fake key) |
| `import "undici"`, no dispatcher call | `invalid content-length header` |
| `import "undici"` + `setGlobalDispatcher` | `invalid content-length header` |

Any entry point that touches `raw-fetch` loads undici, which in practice means all of
them.

## Scope: the server was never affected

`server.ts` calls `configureHttpDispatcher()`, which drops the SDK's explicit header and
lets undici compute it once. Confirmed in production rather than assumed:

- 30 days of logs, **831,512 records scanned**, filtered for
  `release failed|REQUEST_RELEASE|Connection error` → **0 matches**
- **0** sessions left `RUNNING`
- the **30 most recent completed sessions ended in 0.1–1.5 min**, not at the 90 min
  timeout a missed release would produce

What was affected is entry points that could not call it. Until v1.20.0 exported
`./lib/http`, that meant every consumer-owned script, probe and batch job:
`@enricai/barnacle/lib/http` failed to resolve with `ERR_PACKAGE_PATH_NOT_EXPORTED`. A
consumer probe measured **every release failing** — 27 across five runs — with every
session sitting `RUNNING` until its own timeout — while production, running the same engine code, saw none.

## A caveat worth recording

A patch applied to one resolved copy of the SDK does not protect another.
`configureHttpDispatcher()` patches `Object.getPrototypeOf(Browserbase.prototype)` of
whichever copy *it* loaded. In a consumer that ends up with two copies — one hoisted for
the engine, one under its own `stagehand` — the other copy stays unpatched:

```
2.19.1 (engine's copy):  contentLength:null present -> true
2.16.0 (consumer's copy): contentLength:null present -> false
```

This cost real diagnostic time: testing against the wrong copy made it look as though
the production path failed too.

## Fixes

Three, and they are complementary:

1. **`configureHttpDispatcher()`** drops the SDK's header. Correct, but only where it is
   called.
2. **Export `./lib/http`** (v1.20.0) so a consumer's own entry points can call it at all.
3. **Release over the installed undici's `fetch`, bounded** (this change) so the release
   is correct regardless of whether that setup ran, and so it can never outlive the run
   awaiting teardown.

Verified independently against the reproduction:

| variant | result |
|---|---|
| unpatched | `invalid content-length header` |
| `configureHttpDispatcher()`'s header patch | reaches the API |
| caller-supplied undici `fetch` | reaches the API |

## Relation to #665

#665 bounded `stagehand.close()` and moved the release into a `finally`, fixing the other
way to miss it: a close that never returns taking the release with it. Necessary but not
sufficient — the sessions measured here closed cleanly and still failed to release.

## A correction

An earlier version of this report blamed Node's **bundled** undici 6 for rejecting the
header, and quoted a stack trace as proof. That was wrong, and the trace's own frames
said so: they read `undici@8.12.2`, the installed version. Direct probing shows neither
bundled 6.29.1 nor installed 8.12.3 rejects a well-formed `content-length` through
`fetch`; the rejection needs the comma-joined value above, produced on the dispatcher
path. An earlier version before that blamed the SDK keep-alive patch consumers carry,
which is also not the cause — global `fetch` ignores the `agent` the SDK attaches
(verified: a bogus agent still returns HTTP 401 from the live API).
