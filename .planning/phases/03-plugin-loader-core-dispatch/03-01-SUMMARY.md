---
phase: 03-plugin-loader-core-dispatch
plan: "01"
subsystem: plugins/loader
tags: [plugin-system, dispatch, audit, error-mapping, tdd]
dependency_graph:
  requires:
    - src/site-plugin.ts
    - src/scraper/pool.ts
    - src/scraper/errors.ts
    - src/api/errors.ts
    - src/lib/db/client.ts
    - src/sites/fema/index.ts
  provides:
    - src/plugins/loader.ts
  affects:
    - src/server.ts (registerRoutes() replaces inline loop when Phase 3 wires it in)
tech_stack:
  added: []
  patterns:
    - Plugin registry pattern (SITE_PLUGINS array typed as SitePlugin<unknown, unknown>[])
    - Audit persistence on both success and failure paths before re-throw
    - ScraperError → VpsError mapping inside dispatch() catch block
key_files:
  created:
    - src/plugins/loader.ts
    - src/plugins/loader.test.ts
  modified: []
decisions:
  - "Cast request.log as unknown as Logger to satisfy SitePluginContext.logger — Fastify's FastifyBaseLogger does not extend our custom pino.Logger type; the cast is safe because buildServer configures Fastify with our own logger instance"
  - "Used vi.hoisted() + vi.mock() pattern (instead of top-level await import) for loader tests — NodeNext module mode in tsconfig disallows top-level await in .ts files at typecheck time"
metrics:
  duration: "~15 minutes"
  completed: "2026-05-15"
  tasks_completed: 2
  tasks_total: 2
  files_created: 2
  files_modified: 0
---

# Phase 3 Plan 01: Plugin Loader Core Dispatch Summary

**One-liner:** Dispatch engine with Steel session acquisition, SiteSubmission audit persistence on both paths, and ScraperError → VpsError mapping — all covered by 8 unit tests.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Create src/plugins/loader.ts | 58a7a01 | src/plugins/loader.ts (created) |
| 2 | Create src/plugins/loader.test.ts | 8c59890 | src/plugins/loader.test.ts (created) |

## What Was Built

`src/plugins/loader.ts` exports three symbols:

- **SITE_PLUGINS** — typed `SitePlugin<unknown, unknown>[]`, initialized with `femaPlugin` cast. Adding a new site requires only a new entry here.
- **dispatch()** — acquires a Steel session via `runWithSession()`, calls `plugin.execute()`, writes a `SiteSubmission` row on both success (`status: "submitted"`) and failure (`status: "error"`), then maps `CaptchaError` → `CaptchaEncounteredError`, any other `ScraperError` → `ScrapeFailureError`, and non-scraper errors pass through unchanged. DB write always precedes re-throw.
- **registerRoutes()** — loops `SITE_PLUGINS` and registers a Fastify POST route per plugin. Every route carries `onRequest: [app.authenticate]` (ASVS V4 access control, T-03-01 mitigation).

`src/plugins/loader.test.ts` has 8 tests in `describe("dispatch")` and `describe("SITE_PLUGINS")` covering all CORE-01 through CORE-04 behaviors.

## Verification Results

```
pnpm run lint:fix   — PASSED (no fixes applied)
pnpm run typecheck  — PASSED (0 errors)
pnpm run test       — PASSED (200 tests across 16 test files, 0 failures)
```

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] TypeScript type error: request.log incompatible with SitePluginContext.logger**
- **Found during:** Task 1 typecheck
- **Issue:** `FastifyBaseLogger` (the type of `request.log`) does not satisfy `Logger` (our `pino.Logger & { errorWithStack }`) so TypeScript rejected the assignment inside `registerRoutes()`.
- **Fix:** Added `import type { Logger } from "@/types/logging"` and cast `request.log as unknown as Logger`. The cast is safe because `buildServer()` configures Fastify with our custom pino instance via `loggerInstance: logger`.
- **Files modified:** src/plugins/loader.ts
- **Commit:** 58a7a01

**2. [Rule 1 - Bug] Top-level await import() failed tsc in NodeNext module mode**
- **Found during:** Task 2 typecheck (after initial implementation used `await import()`)
- **Issue:** `module: "NodeNext"` treats `.ts` files as CommonJS by default, which disallows top-level `await`. The first version of `loader.test.ts` used `const { dispatch, SITE_PLUGINS } = await import("@/plugins/loader")` to ensure mocks were in place before the module loaded.
- **Fix:** Switched to standard `import { dispatch, SITE_PLUGINS } from "@/plugins/loader"` at top of file with `vi.hoisted()` to hoist mock references before the `vi.mock()` factory closures execute — the same pattern already used in `fema-submission.test.ts`.
- **Files modified:** src/plugins/loader.test.ts
- **Commit:** 8c59890

## Known Stubs

None — all three exports are fully implemented with real behavior.

## Threat Flags

None — no new network endpoints or trust boundaries were introduced beyond what the plan's threat model already covers (T-03-01 through T-03-SC). The `onRequest: [app.authenticate]` hook is present on every route registered by `registerRoutes()`.

## Self-Check: PASSED

- src/plugins/loader.ts — FOUND
- src/plugins/loader.test.ts — FOUND
- Commit 58a7a01 — FOUND
- Commit 8c59890 — FOUND
