# Roadmap: Barnacle Re-Architecture

## Overview

Transform Barnacle from a hardcoded FEMA automator into a plugin-based browser automation engine. The re-arch strips all site-specific code from core and introduces a clean `SitePlugin` interface where each site is a self-contained module. Core owns HTTP, sessions, retries, error mapping, and audit persistence. Four phases: contracts → FEMA isolation → engine wiring → cleanup.

## Phases

- [x] **Phase 1: Core Contracts** - Define the SitePlugin interface, config rename, and generic DB model. Zero behavioral change. (completed 2026-05-15)
- [x] **Phase 2: FEMA Plugin Migration** - Move all FEMA code into src/sites/fema/ as a self-contained plugin. (completed 2026-05-15)
- [ ] **Phase 3: Plugin Loader + Core Dispatch** - Wire the engine: plugin loop in server, dispatch() owns lifecycle.
- [ ] **Phase 4: Cleanup** - Scrub FEMA from core, update metadata, verify clean grep.

## Phase Details

### Phase 1: Core Contracts

**Goal**: Define the plugin interface and supporting infrastructure with zero behavioral change — all existing tests pass.
**Depends on**: Nothing (first phase)
**Requirements**: PLUG-01, PLUG-02, PLUG-03, PLUG-04, PLUG-05, PLUG-06, CONF-01, CONF-02, CONF-03, DB-01, DB-02
**Success Criteria** (what must be TRUE):

  1. `src/site-plugin.ts` exports SitePlugin, SitePluginMeta, SitePluginContext, SitePluginResult with TSDoc
  2. `config.scraper.siteBaseUrls.fema` replaces `config.scraper.femaBaseUrl` with no runtime behavior change
  3. Generic `SiteSubmission` Prisma model exists alongside `FemaSubmission`
  4. `pnpm typecheck` passes with no errors
  5. `pnpm test` — all existing tests pass unchanged

**Plans**: 2 plans

Plans:

- [x] 01-01-PLAN.md — Define SitePlugin interfaces in src/site-plugin.ts
- [x] 01-02-PLAN.md — Rename config field and add SiteSubmission Prisma model

**Cross-cutting constraints:**

- pnpm typecheck passes

### Phase 2: FEMA Plugin Migration

**Goal**: Move all FEMA-specific code into src/sites/fema/ as a self-contained plugin. Add temporary re-export shims at old paths to keep all tests green.
**Depends on**: Phase 1
**Requirements**: FEMA-01, FEMA-02, FEMA-03, FEMA-04, FEMA-05
**Success Criteria** (what must be TRUE):

  1. `src/sites/fema/index.ts` exports `femaPlugin` typed as `SitePlugin`
  2. All existing tests pass (shims preserve old import paths)
  3. FEMA flow receives baseUrl via SitePluginContext (not direct config import)
  4. `pnpm typecheck` passes

**Plans**: 2 plans

Plans:

**Wave 1**

- [x] 02-01-PLAN.md — Create src/sites/fema/ plugin files (schema, flow, service, index) — wave 1, autonomous

**Wave 2** *(blocked on Wave 1 completion)*

- [x] 02-02-PLAN.md — Install three re-export shims, delete old route, swap server.ts to plugin loop, update route test — wave 2, autonomous

### Phase 3: Plugin Loader + Core Dispatch

**Goal**: Wire the engine. Core loops over SITE_PLUGINS to register routes; dispatch() owns session lifecycle, retry, error mapping, and audit persistence.
**Depends on**: Phase 2
**Requirements**: CORE-01, CORE-02, CORE-03, CORE-04, CORE-05, CLEAN-01
**Success Criteria** (what must be TRUE):

  1. `src/plugins/loader.ts` exports SITE_PLUGINS and dispatch()
  2. `src/server.ts` registers routes via plugin loop with no FEMA-specific imports
  3. Shim files at old FEMA paths are deleted
  4. `pnpm test` passes with updated mock paths
  5. FEMA route responds correctly with VPS envelope via app.inject()

**Plans**: 2 plans

Plans:

**Wave 1**

- [ ] 03-01-PLAN.md — Create src/plugins/loader.ts with SITE_PLUGINS, dispatch(), registerRoutes(), and loader.test.ts

**Wave 2** *(blocked on Wave 1 completion)*

- [ ] 03-02-PLAN.md — Update server.ts to call registerRoutes(); update schema test import; extend route test DB mock; delete three shim files

### Phase 4: Cleanup

**Goal**: Scrub all FEMA references from core, update package metadata, and verify the engine is fully site-agnostic.
**Depends on**: Phase 3
**Requirements**: CLEAN-02, CLEAN-03, CLEAN-04, CLEAN-05, CLEAN-06
**Success Criteria** (what must be TRUE):

  1. `grep -r "fema" src/ --include="*.ts" | grep -v sites/fema` returns empty
  2. Root PLAN.md deleted
  3. `pnpm typecheck && pnpm lint:fix && pnpm test` all pass
  4. README contains plugin authoring guide explaining SitePlugin interface

**Plans**: TBD

Plans:

- [ ] 04-01: Delete PLAN.md, update package.json and server.ts metadata, add README plugin guide

## Progress

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Core Contracts | 2/2 | Complete   | 2026-05-15 |
| 2. FEMA Plugin Migration | 2/2 | Complete   | 2026-05-15 |
| 3. Plugin Loader + Core Dispatch | 0/2 | Not started | - |
| 4. Cleanup | 0/TBD | Not started | - |
