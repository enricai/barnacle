---
phase: 03-plugin-loader-core-dispatch
plan: "02"
subsystem: server/plugins
tags: [server, plugin-wiring, shim-deletion, test-update]
dependency_graph:
  requires:
    - src/plugins/loader.ts
    - src/sites/fema/schema.ts
    - src/sites/fema/service.ts
    - src/sites/fema/flow.ts
  provides:
    - src/server.ts (site-agnostic, no FEMA-specific imports)
  affects:
    - src/api/schemas/fema-submission.test.ts
    - src/api/routes/fema-submission.test.ts
tech_stack:
  added: []
  patterns:
    - Delegate pattern — buildServer() calls registerRoutes(app, cfg) with no plugin knowledge
    - Shim-then-delete migration — tests updated before shims removed to keep suite green throughout
key_files:
  created: []
  modified:
    - src/server.ts
    - src/api/schemas/fema-submission.test.ts
    - src/api/routes/fema-submission.test.ts
  deleted:
    - src/api/schemas/fema-submission.ts
    - src/services/fema-submission.ts
    - src/scraper/flows/fema-submission.ts
decisions:
  - "Followed shim-then-delete sequence per T-03-06 — route tests run green after mock extension and before shim deletion, preventing any import-path breakage window"
  - "No change to the submissionId assertion in route test — dispatch() returns result.data which the mock provides without submissionId; the assertion remains valid and serves as a future reminder to expose it from the audit row"
metrics:
  duration: "~10 minutes"
  completed: "2026-05-15"
  tasks_completed: 2
  tasks_total: 2
  files_created: 0
  files_modified: 3
  files_deleted: 3
---

# Phase 3 Plan 02: Server Wiring + Shim Deletion Summary

**One-liner:** server.ts becomes fully site-agnostic by delegating to registerRoutes(app, cfg); three Phase 2 re-export shims deleted after tests updated to canonical import paths.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Wire registerRoutes() into server.ts; update schema test import | e6e3252 | src/server.ts, src/api/schemas/fema-submission.test.ts |
| 2 | Extend route test DB mock; delete three shim files | dea6d76 | src/api/routes/fema-submission.test.ts (modified); src/api/schemas/fema-submission.ts, src/services/fema-submission.ts, src/scraper/flows/fema-submission.ts (deleted) |

## What Was Built

**src/server.ts** — four imports removed (`successEnvelope`, `runWithSession`, `SitePlugin` type, `femaPlugin`); one import added (`registerRoutes` from `@/plugins/loader`); inline `SITE_PLUGINS` array declaration and 28-line for-of loop replaced with a single `await registerRoutes(app, cfg)` call. `drainPool` import retained for the `onClose` hook.

**src/api/schemas/fema-submission.test.ts** — import source changed from `@/api/schemas/fema-submission` (the now-deleted shim) to `@/sites/fema/schema` (canonical path). Imported symbol names unchanged.

**src/api/routes/fema-submission.test.ts** — `vi.mock("@/lib/db/client")` prisma stub extended with `siteSubmission: { create: vi.fn().mockResolvedValue({ id: "stub-id" }) }` so `dispatch()`'s audit write succeeds during route tests.

**Deleted shims** — all three one-line re-export shims removed after their sole dependent (the schema test) was updated to import from the canonical path.

## Verification Results

```
pnpm run lint:fix   — PASSED (no fixes applied, 45 files checked)
pnpm run typecheck  — PASSED (0 errors)
pnpm run test       — PASSED (200 tests across 16 test files, 0 failures)
```

Additional checks:
- `grep -r "api/schemas/fema-submission|services/fema-submission|scraper/flows/fema-submission" src/` — empty (no remaining shim imports)
- `grep -n "femaPlugin|runWithSession|successEnvelope|SitePlugin" src/server.ts` — empty (server.ts is clean)

## Deviations from Plan

None — plan executed exactly as written. Task order (update tests → run tests → delete shims → run full suite) matched the T-03-06 mitigation sequence from the threat model.

## Known Stubs

None — all three plugin exports (`SITE_PLUGINS`, `dispatch()`, `registerRoutes()`) are fully implemented with real behavior from Plan 03-01.

## Threat Flags

None — no new network endpoints or trust boundaries introduced. The `onRequest: [app.authenticate]` hook placement was preserved inside `registerRoutes()` (T-03-05 mitigation confirmed by the 401 test still passing).

## Self-Check: PASSED

- src/server.ts — FOUND, contains `registerRoutes`, no FEMA-specific imports
- src/api/schemas/fema-submission.test.ts — FOUND, imports from `@/sites/fema/schema`
- src/api/routes/fema-submission.test.ts — FOUND, siteSubmission.create stub present
- src/api/schemas/fema-submission.ts — DELETED (confirmed)
- src/services/fema-submission.ts — DELETED (confirmed)
- src/scraper/flows/fema-submission.ts — DELETED (confirmed)
- Commit e6e3252 — FOUND
- Commit dea6d76 — FOUND
