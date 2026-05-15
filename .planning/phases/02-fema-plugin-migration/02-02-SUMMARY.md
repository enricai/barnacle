---
phase: 02-fema-plugin-migration
plan: "02"
subsystem: server/routes/shims
tags:
  - fema
  - plugin
  - refactor
  - server
  - typescript
  - test
dependency_graph:
  requires:
    - "02-01: src/sites/fema/index.ts femaPlugin constant"
    - "02-01: src/sites/fema/service.ts execute() function"
    - "02-01: src/sites/fema/schema.ts femaPluginResponseSchema"
    - "02-01: src/sites/fema/flow.ts submitFemaApplication"
  provides:
    - "src/api/schemas/fema-submission.ts: re-export shim → @/sites/fema/schema"
    - "src/services/fema-submission.ts: re-export shim → @/sites/fema/service"
    - "src/scraper/flows/fema-submission.ts: re-export shim → @/sites/fema/flow"
    - "src/server.ts: site-agnostic SITE_PLUGINS loop replacing femaSubmissionRoute"
    - "src/api/routes/fema-submission.test.ts: updated route test mocking @/sites/fema/service"
  affects:
    - "src/api/routes/fema-submission.ts: deleted (D-03)"
tech_stack:
  added: []
  patterns:
    - "Re-export shim: export * from canonical path (three shims installed)"
    - "Site-agnostic plugin loop: for (const plugin of SITE_PLUGINS) in server.ts"
    - "vi.hoisted() for mock function pre-initialization (Vitest ESM hoisting pattern)"
key_files:
  created: []
  modified:
    - src/api/schemas/fema-submission.ts
    - src/services/fema-submission.ts
    - src/scraper/flows/fema-submission.ts
    - src/server.ts
    - src/api/routes/fema-submission.test.ts
  deleted:
    - src/api/routes/fema-submission.ts
decisions:
  - "Shim files use export * (not named re-exports) — transitional safety net only; no consumer references submitApplication after this plan"
  - "femaPlugin cast as unknown as SitePlugin[] element — FemaSubmissionResult lacks index signature; cast is safe because Fastify validates request.body against bodySchema before execute() runs"
  - "vi.hoisted() used for mockExecute — vi.mock factory hoisting requires the mock fn to be pre-initialized before the factory runs"
  - "vi.mock(@/scraper/pool) added to route test — runWithSession in server.ts would attempt real Steel session creation without this stub; the service mock alone is insufficient because session acquisition precedes execute()"
  - "SITE_PLUGINS is a module-level constant in server.ts — Phase 3 will extract it and the loop body to src/plugins/loader.ts"
metrics:
  duration: "~10 minutes"
  completed_date: "2026-05-15"
  tasks_completed: 3
  files_created: 0
  files_modified: 5
  files_deleted: 1
---

# Phase 2 Plan 02: Consumer Switch Summary

Atomic consumer-side switch from old FEMA file paths to the new `src/sites/fema/` plugin architecture: three thin re-export shims, deletion of the old route file, site-agnostic plugin loop in `server.ts`, and updated route test. Phase 2 is functionally complete.

## Tasks Completed

| Task | Description | Commit | Files |
|------|-------------|--------|-------|
| 1+2 | Install shims + delete old route + plugin loop in server.ts | 1c02655 | 5 files (3 shims, server.ts, deleted route) |
| 3 | Update route test to mock @/sites/fema/service | f3c6908 | src/api/routes/fema-submission.test.ts |

Note: Tasks 1 and 2 were committed atomically (per plan — Pitfall 5: deleting the route file and removing its import from server.ts cannot be split because typecheck breaks between them).

## Shim Files (Task 1)

| File | Final Lines | Content |
|------|------------|---------|
| src/api/schemas/fema-submission.ts | 2 (was 226) | `export * from "@/sites/fema/schema";` |
| src/services/fema-submission.ts | 2 (was 75) | `export * from "@/sites/fema/service";` |
| src/scraper/flows/fema-submission.ts | 2 (was 535) | `export * from "@/sites/fema/flow";` |

Each shim has a one-line comment explaining why the file exists (per CLAUDE.md TSDoc guidance for re-export shims).

## server.ts Changes (Task 2)

**Deleted import (line 18):**
```typescript
// REMOVED:
import { femaSubmissionRoute } from "@/api/routes/fema-submission";
```

**Added imports (alphabetical with existing internal block):**
```typescript
import { successEnvelope } from "@/api/helpers/envelope";
import { drainPool, runWithSession } from "@/scraper/pool";
import type { SitePlugin } from "@/site-plugin";
import { femaPlugin } from "@/sites/fema/index";
```

**New module-level constant (before buildServer()):**
```typescript
// Phase 3 will extract this registry and the loop body to src/plugins/loader.ts.
const SITE_PLUGINS: SitePlugin[] = [femaPlugin as unknown as SitePlugin];
```

**Replaced `await app.register(femaSubmissionRoute)` with:**
```typescript
for (const plugin of SITE_PLUGINS) {
  const routePath = plugin.meta.routeOverride ?? `/v1/${plugin.meta.siteId}/run`;
  const baseUrl = cfg.scraper.siteBaseUrls[plugin.meta.siteId] ?? "";
  app.post<{ Body: Parameters<typeof plugin.execute>[0] }>(
    routePath,
    { onRequest: [app.authenticate], schema: { body: plugin.meta.bodySchema, response: { 200: plugin.meta.responseSchema } } },
    async (request) => {
      const context = { baseUrl, logger: request.log, config: cfg };
      // request.body validated by Fastify against plugin.meta.bodySchema above
      const result = await runWithSession((session) =>
        plugin.execute(request.body as Parameters<typeof plugin.execute>[0], session, context)
      );
      return successEnvelope(result.data);
    }
  );
}
```

**Auth preserved:** `onRequest: [app.authenticate]` is on every plugin route (ASVS V4 — access control enforcement point). The 401 test continues to pass.

**src/api/routes/fema-submission.ts deleted** — superseded by the plugin loop. Not shimmed (D-03).

## Route Test Changes (Task 3)

**Mock target changed:**
- Old: `vi.mock("@/services/fema-submission", () => ({ submitApplication: vi.fn().mockResolvedValue({...full envelope...}) }))`
- New: `vi.mock("@/sites/fema/service", () => ({ execute: mockExecute }))` where `mockExecute = vi.hoisted(() => vi.fn().mockResolvedValue({ data: { confirmationNumber: "FEMA-2024-99999", pagesCompleted: 42 }, auditPayload: {} }))`

**Additional mock added:** `vi.mock("@/scraper/pool", ...)` with `runWithSession` calling task directly — required because server.ts's plugin loop calls `runWithSession` which attempts real Steel session creation before `execute()` is reached.

**Assertion changes:**
- Removed: `expect(body.submissionId).toBe("cltestid")` — Phase 3 field, absent in Phase 2 response
- Added: `expect(body.submissionId).toBeUndefined()` — explicit contract until Phase 3 reverses it
- Kept: `expect(body.confirmationNumber).toBe("FEMA-2024-99999")`
- Kept: `expect(body.pagesCompleted).toBe(42)`
- Kept: `expect(body.status.httpStatus).toBe("OK")`
- Test name: `"returns 200 with the VPS envelope on a valid request"` (was `"returns 200 with submissionId on a valid request"`)

## Test Results

```
Test Files  15 passed (15)
     Tests  192 passed (192)
```

**192 tests — identical to Phase 1 baseline.**

## Auth Preservation Confirmation

`onRequest: [app.authenticate]` is present in every plugin route registration in the `SITE_PLUGINS` loop. The 401 test (`"returns 401 without an auth header"`) confirms this end-to-end.

## Phase 3 Note

Phase 3 will extract the inline plugin loop body into `src/plugins/loader.ts` and wire DB persistence via `dispatch()`. The `SITE_PLUGINS` registry and loop shape are ready for extraction — the loop body is a pure move with no behavioral change required.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Added vi.hoisted() for mock function initialization**
- **Found during:** Task 3
- **Issue:** `vi.mock()` factories are hoisted to top of file; a `const mockExecute = vi.fn()` defined outside the factory is not yet initialized when the factory runs, causing `ReferenceError: Cannot access 'mockExecute' before initialization`
- **Fix:** Used `vi.hoisted(() => vi.fn().mockResolvedValue(...))` to create the mock function in the hoisted context
- **Files modified:** src/api/routes/fema-submission.test.ts
- **Commit:** f3c6908

**2. [Rule 2 - Missing Critical Functionality] Added vi.mock("@/scraper/pool") to route test**
- **Found during:** Task 3
- **Issue:** The plan's mock strategy targeted `@/sites/fema/service`, but `server.ts`'s plugin loop calls `runWithSession` BEFORE calling `plugin.execute`. `runWithSession` attempts to create a real Steel session, which throws `STEEL_API_KEY is required` — causing 500 responses. Mocking the service alone is insufficient because the session creation failure occurs upstream of the execute() call.
- **Fix:** Added `vi.mock("@/scraper/pool", ...)` that stubs `runWithSession` to call the task directly (passing null as session, which is safe since execute is also mocked)
- **Files modified:** src/api/routes/fema-submission.test.ts
- **Commit:** f3c6908

**3. [Rule 1 - Bug] Cast femaPlugin as unknown as SitePlugin for SITE_PLUGINS array**
- **Found during:** Task 2
- **Issue:** `SitePlugin[]` defaults to `SitePlugin<unknown, Record<string, unknown>>[]`, but `FemaSubmissionResult` lacks a string index signature and cannot be directly assigned
- **Fix:** Cast `femaPlugin as unknown as SitePlugin` to satisfy the array type while documenting why the cast is sound (Fastify validates body against bodySchema before execute() runs)
- **Files modified:** src/server.ts
- **Commit:** 1c02655

## Known Stubs

None. All functionality is fully wired. Phase 3 (DB persistence via dispatch()) will add `submissionId` and `submittedAt` to the response.

## Threat Flags

No new security surface introduced beyond what the plan's STRIDE register covered:
- T-02-A: Auth hook preserved on every plugin route — verified by 401 test
- T-02-B: siteBaseUrls index signature confirmed in config.ts before implementation
- T-02-C: Mock target updated to @/sites/fema/service; execute is mocked — verified by all 192 tests passing
- T-02-D: auditPayload not in response, not logged, not persisted (Phase 3 deferred)

## Self-Check: PASSED

- src/api/schemas/fema-submission.ts: FOUND (shim, 2 lines)
- src/services/fema-submission.ts: FOUND (shim, 2 lines)
- src/scraper/flows/fema-submission.ts: FOUND (shim, 2 lines)
- src/server.ts: FOUND (plugin loop in place)
- src/api/routes/fema-submission.test.ts: FOUND (updated test)
- src/api/routes/fema-submission.ts: DELETED (confirmed)
- Commit 1c02655: FOUND
- Commit f3c6908: FOUND
