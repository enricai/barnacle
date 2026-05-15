---
phase: 02-fema-plugin-migration
plan: "01"
subsystem: sites/fema
tags:
  - fema
  - plugin
  - refactor
  - typescript
  - sites
dependency_graph:
  requires:
    - "01-02: SitePlugin interface in src/site-plugin.ts"
    - "01-02: SiteSubmission Prisma model"
  provides:
    - "src/sites/fema/schema.ts: FEMA Zod schemas + femaPluginResponseSchema"
    - "src/sites/fema/flow.ts: config-free browser automation flow with baseUrl param"
    - "src/sites/fema/service.ts: pure execute() satisfying SitePlugin interface"
    - "src/sites/fema/index.ts: femaPlugin constant ready for SITE_PLUGINS registry"
  affects: []
tech_stack:
  added: []
  patterns:
    - "SitePlugin<TPayload, TResult> pattern: first concrete implementation"
    - "config-free plugin: baseUrl injected via SitePluginContext, not config import"
key_files:
  created:
    - src/sites/fema/schema.ts
    - src/sites/fema/flow.ts
    - src/sites/fema/service.ts
    - src/sites/fema/index.ts
  modified: []
decisions:
  - "Export femaPluginResponseSchema alongside femaSubmissionResponseSchema so shim (Plan 02) can use export * without breaking schema tests"
  - "FemaSubmissionResult exported from flow.ts (not redefined in index.ts) so service.ts can import the type without circular deps"
metrics:
  duration: "~15 minutes"
  completed_date: "2026-05-15"
  tasks_completed: 2
  files_created: 4
  files_modified: 0
---

# Phase 2 Plan 01: FEMA Plugin Files Summary

Four self-contained plugin files under `src/sites/fema/` implementing the `SitePlugin` interface — config-free flow with `baseUrl` threaded as a parameter, pure `execute()` with no DB or envelope logic, and `femaPlugin` constant ready for the Plan 02 `SITE_PLUGINS` registry.

## Tasks Completed

| Task | Description | Commit | Files |
|------|-------------|--------|-------|
| 1 | Create schema.ts and flow.ts | d70b30d | src/sites/fema/schema.ts (232 lines), src/sites/fema/flow.ts (536 lines) |
| 2 | Create service.ts and index.ts | da2caea | src/sites/fema/service.ts (33 lines), src/sites/fema/index.ts (21 lines) |

## New Files and Line Counts

| File | Lines | Role |
|------|-------|------|
| src/sites/fema/schema.ts | 232 | All FEMA Zod schemas + inferred types + femaPluginResponseSchema |
| src/sites/fema/flow.ts | 536 | Config-free browser automation flow |
| src/sites/fema/service.ts | 33 | Pure execute() satisfying SitePlugin interface |
| src/sites/fema/index.ts | 21 | femaPlugin constant for SITE_PLUGINS registry |

## Targeted Edits Applied to flow.ts

1. Import path changed from `@/api/schemas/fema-submission` to `@/sites/fema/schema` (D-02)
2. Removed `import { config } from "@/config"` entirely (D-12)
3. Logger name changed from `"scraper/flows/fema-submission"` to `"sites/fema/flow"`
4. `FemaSubmissionResult` interface gained `export` keyword (Pitfall 3)
5. `phase1PreApplication` signature gained `baseUrl: string` as third param (D-11)
6. Inside `phase1PreApplication`: `config.scraper.siteBaseUrls.fema` replaced with `baseUrl`
7. `submitFemaApplication` signature gained `baseUrl: string` as third param (D-11)
8. Fixture-branch `goto` replaced `config.scraper.siteBaseUrls.fema` with `baseUrl` template
9. Internal `phase1PreApplication` call threads `baseUrl` down (Pitfall 4)

## Test Results

`pnpm run test`: **192 tests pass** — identical to pre-plan baseline. The new plugin files are not imported by any consumer yet; no behavioral change.

## Consumer Impact

No consumer has been touched. `server.ts`, the old route file (`src/api/routes/fema-submission.ts`), the old service (`src/services/fema-submission.ts`), the old flow (`src/scraper/flows/fema-submission.ts`), the old schema (`src/api/schemas/fema-submission.ts`), and all tests remain completely unchanged. Plan 02 will flip consumers to the new files and add shims atomically.

## Deviations from Plan

None — plan executed exactly as written. Biome `lint:fix` reordered imports in the three new files (flow.ts, service.ts, index.ts) to comply with CLAUDE.md import order rules; this is expected tooling behavior, not a deviation.

## Known Stubs

None. The plugin files have no placeholder values that affect functionality — all logic is fully implemented.

## Threat Flags

No new security surface introduced. All threats in the plan's STRIDE register are addressed:
- T-02-01: `baseUrl` flows only from `SitePluginContext`, not from request body
- T-02-02: `auditPayload` PII posture unchanged from pre-existing behavior (V2-03 tracked separately)
- T-02-03: Log lines limited to disasterNumber, email, confirmationNumber, pagesCompleted — no SSN/banking/address
- T-02-04: No route registered in Plan 01; auth surface unchanged
- T-02-05: Existing try/catch rethrow shape preserved verbatim

## Self-Check: PASSED

- src/sites/fema/schema.ts: FOUND
- src/sites/fema/flow.ts: FOUND
- src/sites/fema/service.ts: FOUND
- src/sites/fema/index.ts: FOUND
- Commit d70b30d: FOUND
- Commit da2caea: FOUND
